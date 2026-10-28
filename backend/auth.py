"""User accounts: register, log in, log out, change password and delete account.

- Passwords are hashed with Werkzeug's generate_password_hash (scrypt) and never stored in plain text.
- Sessions use Flask's signed cookie (HttpOnly, SameSite=Lax; Secure when configured for HTTPS).
- Visitors who are not logged in practice as guests. Their attempts are linked to a random guest
  id in their session and move into their account when they register or log in.
- Failed logins are rate-limited per email and IP address.
"""
import hashlib
import re
import secrets
import sqlite3
import time
from collections import deque

from flask import Blueprint, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

import db

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD, MAX_PASSWORD = 8, 128
MAX_FAILURES, FAILURE_WINDOW = 5, 15 * 60  # 5 failed attempts per 15 minutes
_failures = {}  # (action, ip, email) -> deque of failure times (in memory, per process)
# Checked against when the email is unknown, so a failed login takes the same time either way.
_DUMMY_HASH = generate_password_hash(secrets.token_urlsafe(16))


def _fingerprint(user):
    """Short digest of the password hash. Stored in the session, so changing the password
    logs out every other device."""
    return hashlib.sha256(user["password_hash"].encode()).hexdigest()[:16]


# ---------- Helpers used by app.py ----------
def current_user():
    """The logged-in user, or None. Ends sessions for deleted accounts or changed passwords."""
    user_id = session.get("user_id")
    if user_id is None:
        return None
    user = db.get_user(user_id)
    if user is None or session.get("pw") != _fingerprint(user):
        session.pop("user_id", None)
        session.pop("pw", None)
        return None
    return user


def current_owner():
    """Who new attempts belong to: the logged-in user, or this browser's guest id."""
    user = current_user()
    if user:
        return db.Owner(user_id=user["id"])
    guest_id = session.get("guest_id")
    if not guest_id:
        guest_id = session["guest_id"] = secrets.token_urlsafe(16)
        session.permanent = True
    return db.Owner(guest_id=guest_id)


def public_user(user):
    return {"id": user["id"], "name": user["name"], "email": user["email"], "created": user["created"]}


# ---------- Internal ----------
def _json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


def _fail(message, status, fields=None):
    body = {"error": message}
    if fields:
        body["fields"] = fields
    return jsonify(body), status


def _password_problem(password):
    if len(password) < MIN_PASSWORD:
        return f"Use at least {MIN_PASSWORD} characters."
    if len(password) > MAX_PASSWORD:
        return f"Use at most {MAX_PASSWORD} characters."
    return None


def _limited(key):
    attempts = _failures.get(key)
    if not attempts:
        return False
    now = time.monotonic()
    while attempts and now - attempts[0] > FAILURE_WINDOW:
        attempts.popleft()
    if not attempts:
        _failures.pop(key, None)
        return False
    return len(attempts) >= MAX_FAILURES


def _record_failure(key):
    _failures.setdefault(key, deque()).append(time.monotonic())


def _start_session(user):
    """Log the user in, keeping any practice they did as a guest in this browser."""
    guest_id = session.get("guest_id")
    session.clear()
    session["user_id"] = user["id"]
    session["pw"] = _fingerprint(user)
    session.permanent = True
    if guest_id:
        db.claim_guest_attempts(guest_id, user["id"])


# ---------- Routes ----------
@bp.get("/me")
def me():
    user = current_user()
    return jsonify({"user": public_user(user) if user else None})


@bp.post("/register")
def register():
    data = _json_body()
    if data is None:
        return _fail("Send the form data as JSON.", 400)
    name = str(data.get("name") or "").strip()
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    fields = {}
    if not 1 <= len(name) <= 60:
        fields["name"] = "Enter your name (up to 60 characters)."
    if len(email) > 254 or not EMAIL_RE.match(email):
        fields["email"] = "Enter a valid email address, such as name@example.com."
    problem = _password_problem(password)
    if problem:
        fields["password"] = problem
    if fields:
        return _fail("Check the highlighted fields.", 400, fields)
    try:
        user_id = db.create_user(name, email, generate_password_hash(password))
    except sqlite3.IntegrityError:
        return _fail("An account with this email already exists. Log in instead.", 409,
                     {"email": "This email is already registered. Log in instead."})
    user = db.get_user(user_id)
    _start_session(user)
    if db.user_count() == 1:
        db.claim_legacy_attempts(user_id)
    return jsonify({"user": public_user(user)}), 201


@bp.post("/login")
def login():
    data = _json_body()
    if data is None:
        return _fail("Send the form data as JSON.", 400)
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    key = ("login", request.remote_addr, email)
    if _limited(key):
        return _fail("Too many failed attempts. Wait 15 minutes, then try again.", 429)
    user = db.get_user_by_email(email)
    valid = check_password_hash(user["password_hash"] if user else _DUMMY_HASH, password)
    if not (user and valid):
        _record_failure(key)
        return _fail("The email or password is incorrect.", 401)
    _failures.pop(key, None)
    _start_session(user)
    return jsonify({"user": public_user(user)})


@bp.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@bp.post("/password")
def change_password():
    user = current_user()
    if not user:
        return _fail("Log in to change your password.", 401)
    data = _json_body() or {}
    key = ("password", request.remote_addr, user["email"])
    if _limited(key):
        return _fail("Too many failed attempts. Wait 15 minutes, then try again.", 429)
    if not check_password_hash(user["password_hash"], str(data.get("current") or "")):
        _record_failure(key)
        return _fail("Your current password is incorrect.", 403, {"current": "This password is incorrect."})
    new = str(data.get("new") or "")
    problem = _password_problem(new)
    if problem:
        return _fail("Choose a different new password.", 400, {"new": problem})
    db.update_password(user["id"], generate_password_hash(new))
    session["pw"] = _fingerprint(db.get_user(user["id"]))  # stay logged in here; other devices are logged out
    return jsonify({"ok": True})


@bp.delete("/account")
def delete_account():
    user = current_user()
    if not user:
        return _fail("Log in to delete your account.", 401)
    data = _json_body() or {}
    key = ("delete", request.remote_addr, user["email"])
    if _limited(key):
        return _fail("Too many failed attempts. Wait 15 minutes, then try again.", 429)
    if not check_password_hash(user["password_hash"], str(data.get("password") or "")):
        _record_failure(key)
        return _fail("The password is incorrect.", 403, {"password": "This password is incorrect."})
    db.delete_user(user["id"])
    session.clear()
    return jsonify({"ok": True})
