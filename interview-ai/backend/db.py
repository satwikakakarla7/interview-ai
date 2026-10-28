"""SQLite storage for users and practice attempts.

Every attempt has one owner: a registered user (user_id) or an anonymous guest browser
(guest_id, a random id kept in the guest's session cookie). Rows created before accounts
existed have neither; the first account registered on this install takes them over.
"""
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import NamedTuple, Optional

# Override with the INTERVIEWAI_DB environment variable (the tests use a temporary file).
DB_PATH = os.environ.get("INTERVIEWAI_DB") or os.path.join(os.path.dirname(__file__), "interview.db")


class Owner(NamedTuple):
    user_id: Optional[int] = None
    guest_id: Optional[str] = None


@contextmanager
def _conn():
    """Commit on success, roll back on error, and always close the connection."""
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        with c:
            yield c
    finally:
        c.close()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _owned(owner):
    """SQL condition and parameters selecting rows that belong to `owner`."""
    if owner.user_id is not None:
        return "user_id = ?", (owner.user_id,)
    return "user_id IS NULL AND guest_id = ?", (owner.guest_id,)


def init_db():
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created TEXT, question_id INTEGER, category TEXT, question TEXT,
            answer TEXT, overall INTEGER, clarity INTEGER, confidence INTEGER,
            relevance INTEGER, sentiment REAL, wpm REAL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created TEXT NOT NULL)""")
        # Migrate databases created before accounts existed.
        columns = {row["name"] for row in c.execute("PRAGMA table_info(attempts)")}
        if "user_id" not in columns:
            c.execute("ALTER TABLE attempts ADD COLUMN user_id INTEGER")
        if "guest_id" not in columns:
            c.execute("ALTER TABLE attempts ADD COLUMN guest_id TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_attempts_guest ON attempts(guest_id)")


# ---------- Attempts ----------
def save_attempt(q, answer, result, owner):
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO attempts (created, question_id, category, question, answer, overall,"
            " clarity, confidence, relevance, sentiment, wpm, user_id, guest_id)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (_now(), q["id"], q["category"], q["question"], answer, result["overall"],
             result["scores"]["clarity"], result["scores"]["confidence"],
             result["scores"]["relevance"], result["sentiment"]["compound"],
             result["metrics"]["wpm"], owner.user_id,
             None if owner.user_id is not None else owner.guest_id))
        return cur.lastrowid


def history(owner, limit=30):
    """The owner's most recent attempts (newest first) and overall averages."""
    where, params = _owned(owner)
    with _conn() as c:
        rows = c.execute(f"SELECT id, created, question_id, category, question, answer, overall,"
                         f" clarity, confidence, relevance, sentiment, wpm FROM attempts"
                         f" WHERE {where} ORDER BY id DESC LIMIT ?", (*params, limit)).fetchall()
        avg = c.execute(f"SELECT COUNT(*) n, AVG(overall) overall, AVG(clarity) clarity,"
                        f" AVG(confidence) confidence, AVG(relevance) relevance,"
                        f" MAX(overall) best, COUNT(DISTINCT question_id) questions"
                        f" FROM attempts WHERE {where}", params).fetchone()
    return [dict(r) for r in rows], {k: (round(avg[k], 1) if avg[k] is not None else 0) for k in avg.keys()}


def question_stats(owner):
    """{question_id: {attempts, avg, best, last}} for every question the owner attempted."""
    where, params = _owned(owner)
    with _conn() as c:
        rows = c.execute(f"SELECT question_id, COUNT(*) n, AVG(overall) avg, MAX(overall) best,"
                         f" MAX(created) last FROM attempts WHERE {where} GROUP BY question_id",
                         params).fetchall()
    return {r["question_id"]: {"attempts": r["n"], "avg": round(r["avg"], 1),
                               "best": r["best"], "last": r["last"]} for r in rows}


def clear(owner):
    where, params = _owned(owner)
    with _conn() as c:
        c.execute(f"DELETE FROM attempts WHERE {where}", params)


def claim_guest_attempts(guest_id, user_id):
    """Move a guest's attempts into the account they just registered or logged in to."""
    with _conn() as c:
        c.execute("UPDATE attempts SET user_id = ?, guest_id = NULL"
                  " WHERE user_id IS NULL AND guest_id = ?", (user_id, guest_id))


def claim_legacy_attempts(user_id):
    """Give attempts saved before accounts existed to the first registered user."""
    with _conn() as c:
        c.execute("UPDATE attempts SET user_id = ? WHERE user_id IS NULL AND guest_id IS NULL",
                  (user_id,))


# ---------- Users ----------
def create_user(name, email, password_hash):
    """Returns the new user's id. Raises sqlite3.IntegrityError if the email is taken."""
    with _conn() as c:
        cur = c.execute("INSERT INTO users (name, email, password_hash, created) VALUES (?,?,?,?)",
                        (name, email, password_hash, _now()))
        return cur.lastrowid


def get_user(user_id):
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def get_user_by_email(email):
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    return dict(row) if row else None


def user_count():
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def update_password(user_id, password_hash):
    with _conn() as c:
        c.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def delete_user(user_id):
    """Delete the account and every attempt it owns."""
    with _conn() as c:
        c.execute("DELETE FROM attempts WHERE user_id = ?", (user_id,))
        c.execute("DELETE FROM users WHERE id = ?", (user_id,))
