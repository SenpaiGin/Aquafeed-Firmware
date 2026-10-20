"""Durable identities and event outbox; physical ambiguity survives restart."""

from __future__ import annotations
import json
import sqlite3
import uuid
from pathlib import Path


class Journal:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(
          sequence_id TEXT NOT NULL, event_sequence INTEGER NOT NULL,
          body TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(sequence_id,event_sequence));
        CREATE TABLE IF NOT EXISTS operations(
          sequence_id TEXT PRIMARY KEY, identity TEXT NOT NULL, state TEXT NOT NULL,
          start_intent INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS occurrences(
          schedule_id TEXT NOT NULL, local_date TEXT NOT NULL, state TEXT NOT NULL,
          PRIMARY KEY(schedule_id,local_date));
        CREATE TABLE IF NOT EXISTS samples(
          boot_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
          acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(boot_id,sequence));
        """)
        self.boot_id = self._meta_uuid("boot_id")
        self.db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('live_sequence','0')")
        self.recover_uncertain()

    def _meta_uuid(self, key: str) -> str:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        if row:
            return row[0]
        value = str(uuid.uuid4())
        self.db.execute("INSERT INTO meta VALUES(?,?)", (key, value))
        return value

    def recover_uncertain(self) -> None:
        # Never resume work after restart. Anything that crossed durable start intent
        # is physically ambiguous and stays locked for maintenance.
        self.db.execute("UPDATE operations SET state='unknown' WHERE state IN ('accepted','running') AND start_intent=1")
        self.db.execute("UPDATE operations SET state='not_started' WHERE state='accepted' AND start_intent=0")

    def reserve(self, sequence_id: str, identity: dict) -> bool:
        try:
            self.db.execute("INSERT INTO operations(sequence_id,identity,state) VALUES(?,?,'accepted')",
                            (sequence_id, json.dumps(identity, sort_keys=True, allow_nan=False)))
            return True
        except sqlite3.IntegrityError:
            row = self.db.execute("SELECT identity FROM operations WHERE sequence_id=?", (sequence_id,)).fetchone()
            if row and row[0] != json.dumps(identity, sort_keys=True, allow_nan=False):
                raise ValueError("sequence identity reused with different content")
            return False

    def mark_start_intent(self, sequence_id: str) -> None:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("SELECT state FROM operations WHERE sequence_id=?", (sequence_id,)).fetchone()
            active = self.db.execute("SELECT 1 FROM operations WHERE state IN ('accepted','running','unknown') LIMIT 1").fetchone()
            if not row or row[0] != "accepted" or active is None:
                raise RuntimeError("operation is not reserved")
            self.db.execute("UPDATE operations SET state='running',start_intent=1 WHERE sequence_id=?", (sequence_id,))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def append_event(self, sequence_id: str, event_sequence: int, event: dict) -> None:
        self.db.execute("INSERT INTO events(sequence_id,event_sequence,body) VALUES(?,?,?)",
                        (sequence_id, event_sequence, json.dumps(event, sort_keys=True, allow_nan=False)))

    def pending_events(self, limit: int = 100) -> list[dict]:
        rows = self.db.execute("SELECT body FROM events WHERE acknowledged=0 ORDER BY rowid LIMIT ?", (limit,))
        return [json.loads(r[0]) for r in rows]

    def live_sequence(self) -> int:
        row = self.db.execute("SELECT value FROM meta WHERE key='live_sequence'").fetchone()
        value = int(row[0]) + 1
        self.db.execute("UPDATE meta SET value=? WHERE key='live_sequence'", (str(value),))
        return value
