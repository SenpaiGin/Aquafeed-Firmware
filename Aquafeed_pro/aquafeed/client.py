"""Authenticated outbound v2 transport. Never writes directly to Supabase tables."""

from __future__ import annotations
import json
import urllib.error
import urllib.request
import uuid


class DeviceClient:
    def __init__(self, config: dict, credential: str):
        self.base = config["supabase_url"].rstrip("/") + "/functions/v1/device-api/v2"
        self.key = config["supabase_publishable_key"]
        self.credential = credential.strip()
        if not self.credential:
            raise ValueError("device credential is empty")

    def post(self, route: str, body: dict, timeout: float = 20) -> dict:
        payload = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
        request_id = body["request_id"]
        request = urllib.request.Request(
            self.base + "/" + route,
            data=payload,
            headers={"Authorization": "Bearer " + self.credential,
                     "apikey": self.key, "Content-Type": "application/json",
                     "X-Protocol-Major": "2", "X-Request-Id": request_id},
            method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            # Do not include request headers, response bodies or credentials in logs.
            raise RuntimeError(f"device API returned HTTP {exc.code}") from None
        if not isinstance(result, dict):
            raise ValueError("device API response is not an object")
        return result

    def sync(self, body: dict) -> dict:
        body = dict(body)
        body["request_id"] = str(uuid.uuid4())
        return self.post("sync", body)
