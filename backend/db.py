"""SQLite storage for sessions (screening + baseline). File: data/safecheck.db"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

# SAFECHECK_DB lets tests / rehearsals use a separate database file.
DB_PATH = Path(os.environ.get("SAFECHECK_DB") or Path(__file__).resolve().parent.parent / "data" / "safecheck.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL,            -- ISO-8601 UTC
    subject       TEXT,                     -- name / ID, NULL = anonymous
    mode          TEXT NOT NULL,            -- 'screening' | 'baseline'
    lang          TEXT,                     -- speech language: 'en' | 'ml'
    overall_score REAL,
    result        TEXT,                     -- Normal | Borderline | Flag | Incomplete
    metrics_json  TEXT NOT NULL,            -- raw metrics per test
    scores_json   TEXT                      -- full scoring breakdown
);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions(mode);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["metrics"] = json.loads(d.pop("metrics_json") or "{}")
    d["scores"] = json.loads(d.pop("scores_json") or "null")
    return d


def insert_session(subject, mode, lang, metrics, scores) -> int:
    with connect() as con:
        cur = con.execute(
            "INSERT INTO sessions (created_at, subject, mode, lang, overall_score, result, metrics_json, scores_json)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                subject or None, mode, lang,
                scores.get("overall"), scores.get("result"),
                json.dumps(metrics), json.dumps(scores),
            ),
        )
        return cur.lastrowid


def list_sessions(mode=None, result=None, q=None, date_from=None, date_to=None) -> list[dict]:
    sql, args = "SELECT * FROM sessions WHERE 1=1", []
    if mode:
        sql += " AND mode = ?"; args.append(mode)
    if result:
        sql += " AND result = ?"; args.append(result)
    if q:
        sql += " AND subject LIKE ?"; args.append(f"%{q}%")
    if date_from:
        sql += " AND created_at >= ?"; args.append(date_from)
    if date_to:
        sql += " AND created_at <= ?"; args.append(date_to + "T23:59:59Z")
    sql += " ORDER BY id DESC"
    with connect() as con:
        return [_row(r) for r in con.execute(sql, args)]


def get_session(sid: int) -> dict | None:
    with connect() as con:
        r = con.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
        return _row(r) if r else None


def delete_session(sid: int) -> bool:
    with connect() as con:
        return con.execute("DELETE FROM sessions WHERE id = ?", (sid,)).rowcount > 0


def baseline_sessions() -> list[dict]:
    with connect() as con:
        return [_row(r) for r in con.execute("SELECT * FROM sessions WHERE mode = 'baseline'")]
