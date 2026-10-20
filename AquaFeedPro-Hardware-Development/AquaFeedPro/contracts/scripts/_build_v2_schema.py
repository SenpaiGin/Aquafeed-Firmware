from pathlib import Path

root = Path(__file__).resolve().parents[1]
schema_path = root / "schemas/v2.schema.json"
schema = schema_path.read_text(encoding="utf-8")


def replace_once(old: str, new: str) -> None:
    global schema
    if new in schema:
        return
    if schema.count(old) != 1:
        raise ValueError("v2 schema source no longer matches the expected ART-97 insertion point")
    schema = schema.replace(old, new, 1)


# v2 has accumulated versioned additions that are not present in v1. Update its
# existing source in place so regeneration preserves every accepted v2 DTO.
replace_once('"title": "AquaFeed Pro wire contract 2.3.0"', '"title": "AquaFeed Pro wire contract 2.4.0"')
replace_once(
    '        "feed_remaining_monitoring",\n        "nozzles",',
    '        "feed_remaining_monitoring",\n        "feed_capacity_g",\n        "nozzles",',
)
replace_once(
    '        "feed_remaining_monitoring": {\n'
    '          "type": "boolean",\n'
    '          "description": "One shared container/load-cell inventory, never per-nozzle stock."\n'
    '        },\n',
    '        "feed_remaining_monitoring": {\n'
    '          "type": "boolean",\n'
    '          "description": "One shared container/load-cell inventory, never per-nozzle stock."\n'
    '        },\n'
    '        "feed_capacity_g": {\n'
    '          "oneOf": [\n'
    '            {\n'
    '              "type": "number",\n'
    '              "exclusiveMinimum": 0,\n'
    '              "maximum": 1.7976931348623157e+308\n'
    '            },\n'
    '            {\n'
    '              "type": "null"\n'
    '            }\n'
    '          ],\n'
    '          "description": "Capacity of the shared container. Null means unknown; it does not set any nozzle dose limit."\n'
    '        },\n',
)
replace_once(
    '"description": "Shared device monitoring and schedule limits plus exactly two independent nozzle capabilities."',
    '"description": "Shared device monitoring, hopper capacity and schedule limits plus exactly two independent nozzle dose capabilities."',
)
replace_once(
    '        "CAPABILITY_MISMATCH",\n        "VALIDATION_FAILED"\n      ]',
    '        "CAPABILITY_MISMATCH",\n        "VALIDATION_FAILED",\n'
    '        "INVENTORY_UNAVAILABLE",\n        "INSUFFICIENT_INVENTORY"\n      ]',
)
replace_once(
    '      "description": "Looks up the original command using the same device, installation, and idempotency key."\n'
    '    },\n',
    '      "description": "Looks up the original command using the same device, installation, and idempotency key."\n'
    '    },\n'
    '    "ManualFeedRecoveryResponse": {\n'
    '      "type": "object",\n'
    '      "required": [\n'
    '        "request_id",\n'
    '        "resolution",\n'
    '        "command"\n'
    '      ],\n'
    '      "properties": {\n'
    '        "request_id": {\n'
    '          "$ref": "#/$defs/Uuid"\n'
    '        },\n'
    '        "resolution": {\n'
    '          "type": "string",\n'
    '          "enum": [\n'
    '            "created",\n'
    '            "existing"\n'
    '          ]\n'
    '        },\n'
    '        "command": {\n'
    '          "$ref": "#/$defs/CommandStatusDTO"\n'
    '        }\n'
    '      },\n'
    '      "description": "created: a terminal rejected no-feed receipt now fences the saved key. existing: the key already had a command, returned unchanged. Never starts a feed."\n'
    '    },\n',
)

schema_path.write_text(schema, encoding="utf-8")
