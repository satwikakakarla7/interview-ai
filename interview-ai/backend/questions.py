"""Interview question bank.

Questions live in data/questions.json so they can be edited without touching code.
Each question has:
    id, category, difficulty, question,
    keywords      - key concepts; "lead|led" means either term counts (first term is shown)
    model_answer  - shown after an attempt, and used as the reference for relevance scoring
    tips          - what interviewers look for (tips[0] doubles as the pre-attempt hint)
    mistakes      - common mistakes to avoid
    follow_ups    - likely follow-up questions
"""
import json
import os

from analyzer import keyword_label, keyword_terms

DATA_FILE = os.path.join(os.path.dirname(__file__), "data", "questions.json")

# Display order and grouping for the category picker. Categories found in the data file
# but missing here are still served, under "Other".
CATEGORY_GROUPS = [
    ("General", ["HR", "Behavioral", "Situational"]),
    ("Technical", ["Programming & OOP", "Data Structures & Algorithms", "Databases & SQL",
                   "OS & Networking", "Web & APIs", "Machine Learning", "System Design"]),
]
DIFFICULTIES = ["Easy", "Medium", "Hard"]
_REQUIRED = ("id", "category", "question", "keywords", "model_answer")


def _load(path=DATA_FILE):
    with open(path, encoding="utf-8") as fh:
        items = json.load(fh)
    seen = set()
    for q in items:
        missing = [k for k in _REQUIRED if not q.get(k)]
        if missing:
            raise ValueError(f"Question {q.get('id', '?')} in {path} is missing: {', '.join(missing)}")
        if q["id"] in seen:
            raise ValueError(f"Duplicate question id {q['id']} in {path}")
        seen.add(q["id"])
        q.setdefault("difficulty", "Medium")
        if q["difficulty"] not in DIFFICULTIES:
            raise ValueError(f"Question {q['id']}: difficulty must be one of {DIFFICULTIES}")
        for key in ("tips", "mistakes", "follow_ups"):
            q.setdefault(key, [])
    known = [c for _, cats in CATEGORY_GROUPS for c in cats]
    rank = {c: i for i, c in enumerate(known)}
    items.sort(key=lambda q: (rank.get(q["category"], len(known)), q["category"],
                              DIFFICULTIES.index(q["difficulty"]), q["id"]))
    return items


QUESTIONS = _load()
_BY_ID = {q["id"]: q for q in QUESTIONS}


def get_question(qid):
    return _BY_ID.get(qid)


def category_groups():
    """[{'label': 'General', 'categories': ['HR', ...]}, ...] limited to categories in use."""
    used = {q["category"] for q in QUESTIONS}
    groups = [{"label": label, "categories": [c for c in cats if c in used]}
              for label, cats in CATEGORY_GROUPS]
    known = {c for _, cats in CATEGORY_GROUPS for c in cats}
    other = sorted(used - known)
    if other:
        groups.append({"label": "Other", "categories": other})
    return [g for g in groups if g["categories"]]


def public_view(q):
    """What the learner may see before attempting: no model answer or keywords."""
    return {"id": q["id"], "category": q["category"], "difficulty": q["difficulty"],
            "question": q["question"], "hint": q["tips"][0] if q["tips"] else None}


def learning_view(q):
    """Revealed after an attempt so the learner can compare and improve."""
    return {
        "model_answer": q["model_answer"],
        "tips": q["tips"],
        "mistakes": q["mistakes"],
        "follow_ups": q["follow_ups"],
        "concepts": [keyword_label(k) for k in q["keywords"]],
        # The accepted terms for each concept, used to highlight one occurrence per concept.
        "concept_terms": [[t.lower() for t in keyword_terms(k)] for k in q["keywords"]],
    }
