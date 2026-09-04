#!/usr/bin/env python3
"""Report whether the Drawing API task database has nonterminal work."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote


TERMINAL = ("completed", "completed_with_warnings", "failed_retryable", "failed")
TASK_TABLES = ("ingestion_tasks", "parse_tasks")


def nonterminal_counts(database_path: Path) -> dict[str, int]:
    absolute = database_path.resolve(strict=True)
    uri = f"file:{quote(str(absolute), safe='/')}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        return {
            table: connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE status NOT IN (?, ?, ?, ?)",
                TERMINAL,
            ).fetchone()[0]
            for table in TASK_TABLES
        }


def active_result(database_path: Path) -> str:
    absolute = database_path.resolve(strict=True)
    uri = f"file:{quote(str(absolute), safe='/')}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        for status in ("queued", "processing"):
            if any(
                connection.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE status = ?",
                    (status,),
                ).fetchone()[0]
                for table in TASK_TABLES
            ):
                return status
    return "active"


def main(arguments: list[str]) -> int:
    if len(arguments) != 1:
        print(json.dumps({"result": "error"}, separators=(",", ":")))
        return 1

    database_path = Path(arguments[0])
    try:
        counts = nonterminal_counts(database_path)
        result = "idle" if all(count == 0 for count in counts.values()) else active_result(database_path)
    except (OSError, sqlite3.Error):
        print(json.dumps({"result": "error"}, separators=(",", ":")))
        return 1

    print(json.dumps({"result": result, **counts}, separators=(",", ":")))
    return 0 if result == "idle" else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
