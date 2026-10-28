"""Flask backend for the AI-Powered Interview Readiness & Feedback System.

Run:  python app.py   ->  http://127.0.0.1:5000
"""
import io
import os
import random
import secrets
from datetime import timedelta

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

import auth
import db
from analyzer import analyze
from questions import (DIFFICULTIES, QUESTIONS, category_groups, get_question,
                       learning_view, public_view)

BACKEND = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.abspath(os.path.join(BACKEND, "..", "frontend"))
MAX_ANSWER_CHARS = 20000


def _secret_key():
    """INTERVIEWAI_SECRET_KEY if set; otherwise a random key saved in backend/instance/,
    so sessions survive restarts. Never commit that file."""
    key = os.environ.get("INTERVIEWAI_SECRET_KEY")
    if key:
        return key
    path = os.path.join(BACKEND, "instance", "secret_key")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    key = secrets.token_hex(32)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(key)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


app = Flask(__name__, static_folder=FRONTEND, static_url_path="")
app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Set INTERVIEWAI_SECURE_COOKIES=1 when the site is served over HTTPS.
    SESSION_COOKIE_SECURE=os.environ.get("INTERVIEWAI_SECURE_COOKIES") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    # Only send the session cookie when it changes, so a slow request that finishes after
    # logout can't restore the old session.
    SESSION_REFRESH_EACH_REQUEST=False,
    MAX_CONTENT_LENGTH=32 * 1024 * 1024,  # largest accepted audio upload
)
# The bundled frontend is served from the same origin, so CORS is off unless you host the
# frontend elsewhere: INTERVIEWAI_CORS_ORIGINS=https://your-frontend.example
_origins = [o.strip() for o in os.environ.get("INTERVIEWAI_CORS_ORIGINS", "").split(",") if o.strip()]
if _origins:
    CORS(app, origins=_origins, supports_credentials=True)
app.register_blueprint(auth.bp)
db.init_db()


@app.route("/")
def index():
    return send_from_directory(FRONTEND, "index.html")


def _filtered(category=None, difficulty=None):
    return [q for q in QUESTIONS
            if (not category or category == "All" or q["category"] == category)
            and (not difficulty or difficulty == "All" or q["difficulty"] == difficulty)]


@app.get("/api/questions")
def questions():
    qs = _filtered(request.args.get("category"), request.args.get("difficulty"))
    groups = category_groups()
    return jsonify({
        "questions": [public_view(q) for q in qs],
        "categories": [c for g in groups for c in g["categories"]],
        "groups": groups,
        "difficulties": DIFFICULTIES,
        "total": len(QUESTIONS),
    })


@app.get("/api/questions/random")
def random_question():
    exclude = {int(x) for x in request.args.get("exclude", "").split(",") if x.strip().isdigit()}
    pool = _filtered(request.args.get("category"), request.args.get("difficulty"))
    pool = [q for q in pool if q["id"] not in exclude] or pool
    if not pool:
        return jsonify({"error": "No questions match these filters."}), 404
    return jsonify(public_view(random.choice(pool)))


@app.post("/api/analyze")
def analyze_answer():
    data = request.get_json(silent=True) or {}
    try:
        q = get_question(int(data.get("question_id", 0)))
    except (TypeError, ValueError):
        q = None
    answer = str(data.get("answer") or "").strip()
    if not q:
        return jsonify({"error": "Unknown question."}), 400
    if len(answer.split()) < 3:
        return jsonify({"error": "Please give a longer answer (at least a few words)."}), 400
    if len(answer) > MAX_ANSWER_CHARS:
        return jsonify({"error": "That answer is too long. Keep it under about 3,000 words."}), 400
    try:
        duration = float(data["duration"]) if data.get("duration") else None
    except (TypeError, ValueError):
        duration = None
    result = analyze(q, answer, duration)
    db.save_attempt(q, answer, result, auth.current_owner())
    # Revealed only after an attempt: model answer, tips, common mistakes, follow-ups.
    result["learn"] = learning_view(q)
    return jsonify(result)


@app.post("/api/transcribe")
def transcribe():
    """Server-side speech-to-text for an uploaded audio file (WAV/AIFF/FLAC; others need ffmpeg+pydub)."""
    try:
        import speech_recognition as sr
    except ImportError:
        return jsonify({"error": "SpeechRecognition is not installed on the server."}), 501
    f = request.files.get("audio")
    if not f:
        return jsonify({"error": "No audio file uploaded."}), 400
    raw = f.read()
    ext = os.path.splitext(f.filename or "")[1].lower()
    try:
        if ext not in (".wav", ".aiff", ".aif", ".flac"):
            from pydub import AudioSegment  # needs ffmpeg
            seg = AudioSegment.from_file(io.BytesIO(raw))
            buf = io.BytesIO()
            seg.export(buf, format="wav")
            raw = buf.getvalue()
        r = sr.Recognizer()
        with sr.AudioFile(io.BytesIO(raw)) as source:
            audio = r.record(source)
            duration = len(audio.frame_data) / (audio.sample_rate * audio.sample_width)
        text = r.recognize_google(audio)
        return jsonify({"text": text, "duration": round(duration, 1)})
    except sr.UnknownValueError:
        return jsonify({"error": "Could not understand the audio."}), 422
    except sr.RequestError as e:
        return jsonify({"error": f"Speech service unavailable: {e}"}), 503
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"Could not process audio ({e}). Try a WAV file."}), 400


@app.get("/api/history")
def history():
    try:
        limit = max(1, min(int(request.args.get("limit", 30)), 200))
    except ValueError:
        limit = 30
    owner = auth.current_owner()
    rows, averages = db.history(owner, limit)
    stats = db.question_stats(owner)
    for r in rows:
        q = get_question(r["question_id"])
        if q:  # report the current category, in case a question was re-categorised
            r["category"], r["difficulty"] = q["category"], q["difficulty"]

    by_category = []
    for group in category_groups():
        for cat in group["categories"]:
            ids = [q["id"] for q in QUESTIONS if q["category"] == cat]
            done = [stats[i] for i in ids if i in stats]
            n = sum(s["attempts"] for s in done)
            by_category.append({
                "category": cat, "questions": len(ids), "practiced": len(done), "attempts": n,
                "avg": round(sum(s["avg"] * s["attempts"] for s in done) / n, 1) if n else None,
            })
    return jsonify({"attempts": rows, "averages": averages, "by_question": stats,
                    "by_category": by_category, "total_questions": len(QUESTIONS)})


@app.delete("/api/history")
def clear_history():
    db.clear(auth.current_owner())  # only the current user's (or guest's) attempts
    return jsonify({"ok": True})


@app.errorhandler(HTTPException)
def http_error(e):
    """JSON errors for the API; normal pages for everything else."""
    if request.path.startswith("/api/"):
        return jsonify({"error": e.description or e.name}), e.code
    return e


if __name__ == "__main__":
    # Local development server. For deployment use a WSGI server, e.g. `gunicorn app:app`.
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "5000")),
            debug=os.environ.get("INTERVIEWAI_DEBUG", "1") == "1")
