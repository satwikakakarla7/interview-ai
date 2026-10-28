"""Tests for the question bank, the scoring engine and the API.

Run from the backend folder:
    python -m unittest discover tests -v
"""
import atexit
import os
import re
import sys
import tempfile
import unittest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
atexit.register(lambda: os.path.exists(_tmp.name) and os.remove(_tmp.name))
os.environ["INTERVIEWAI_DB"] = _tmp.name  # never touch the real history
os.environ["INTERVIEWAI_SECRET_KEY"] = "test-secret-key"

import analyzer  # noqa: E402
import db  # noqa: E402
from app import app  # noqa: E402
from questions import DIFFICULTIES, QUESTIONS, category_groups  # noqa: E402


class QuestionBankTests(unittest.TestCase):
    """Run these after adding or editing questions in data/questions.json."""

    def test_ids_are_unique(self):
        ids = [q["id"] for q in QUESTIONS]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_question_is_complete(self):
        for q in QUESTIONS:
            with self.subTest(id=q["id"]):
                self.assertIn(q["difficulty"], DIFFICULTIES)
                self.assertTrue(q["question"].strip())
                self.assertGreaterEqual(len(q["keywords"]), 3)
                self.assertTrue(q["tips"], "tips[0] is used as the pre-attempt hint")
                self.assertTrue(q["mistakes"])
                self.assertTrue(q["follow_ups"])

    def test_keywords_appear_in_model_answer(self):
        for q in QUESTIONS:
            for kw in q["keywords"]:
                with self.subTest(id=q["id"], keyword=kw):
                    self.assertTrue(analyzer.keyword_hit(kw, q["model_answer"]))

    def test_model_answers_avoid_fillers_and_hedges(self):
        for q in QUESTIONS:
            with self.subTest(id=q["id"]):
                self.assertEqual(analyzer._count_fillers(q["model_answer"]), {})
                self.assertEqual(analyzer._count_phrases(q["model_answer"], analyzer.HEDGES), {})

    def test_model_answers_score_well(self):
        for q in QUESTIONS:
            with self.subTest(id=q["id"]):
                result = analyzer.analyze(q, q["model_answer"])
                self.assertGreaterEqual(result["overall"], 80)

    def test_categories_are_grouped(self):
        grouped = {c for g in category_groups() for c in g["categories"]}
        self.assertEqual(grouped, {q["category"] for q in QUESTIONS})


class AnalyzerTests(unittest.TestCase):
    def test_keyword_alternatives_and_word_start_matching(self):
        self.assertTrue(analyzer.keyword_hit("lead|led", "I led a team of four"))
        self.assertTrue(analyzer.keyword_hit("lead", "my leadership role"))
        self.assertFalse(analyzer.keyword_hit("put", "the input field"))
        self.assertEqual(analyzer.keyword_label("cross-validation|cross validation"), "cross-validation")

    def test_fillers_ignore_normal_phrases(self):
        self.assertEqual(analyzer._count_fillers("I would like to lead. A RIGHT JOIN keeps rows. What kind of index?"), {})
        self.assertEqual(analyzer._count_fillers("It was like, um, hard, right?"), {"um": 1, "like": 1, "right": 1})

    def test_better_answer_scores_higher(self):
        q = next(q for q in QUESTIONS if q["category"] == "Machine Learning")
        weak = analyzer.analyze(q, "I am not sure, maybe it is something with computers I guess.")
        strong = analyzer.analyze(q, q["model_answer"])
        self.assertGreater(strong["overall"], weak["overall"] + 20)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.client.delete("/api/history")

    def test_questions_hide_answers_before_an_attempt(self):
        data = self.client.get("/api/questions").get_json()
        self.assertEqual(len(data["questions"]), len(QUESTIONS))
        for q in data["questions"]:
            self.assertNotIn("model_answer", q)
            self.assertNotIn("keywords", q)

    def test_filters(self):
        data = self.client.get("/api/questions?category=HR&difficulty=Easy").get_json()
        self.assertTrue(data["questions"])
        self.assertTrue(all(q["category"] == "HR" and q["difficulty"] == "Easy" for q in data["questions"]))

    def test_analyze_reveals_learning_content_and_saves_history(self):
        q = QUESTIONS[0]
        res = self.client.post("/api/analyze", json={"question_id": q["id"], "answer": q["model_answer"]})
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertEqual(body["learn"]["model_answer"], q["model_answer"])
        self.assertTrue(body["learn"]["tips"])
        history = self.client.get("/api/history").get_json()
        self.assertIn(str(q["id"]), history["by_question"])

    def test_analyze_rejects_bad_input(self):
        self.assertEqual(self.client.post("/api/analyze", json={"question_id": "abc", "answer": "a b c d"}).status_code, 400)
        self.assertEqual(self.client.post("/api/analyze", json={"question_id": QUESTIONS[0]["id"], "answer": "too short"}).status_code, 400)

    def test_unknown_api_route_returns_json(self):
        res = self.client.get("/api/does-not-exist")
        self.assertEqual(res.status_code, 404)
        self.assertIn("error", res.get_json())


class AccountTests(unittest.TestCase):
    PASSWORD = "correct horse 42"

    def _client(self):
        return app.test_client()  # each client has its own cookie jar, like a separate browser

    def _register(self, client, email, password=None, name="Test User"):
        return client.post("/api/auth/register", json={"name": name, "email": email,
                                                       "password": password or self.PASSWORD})

    def _attempt(self, client, qid=None):
        q = QUESTIONS[0] if qid is None else next(x for x in QUESTIONS if x["id"] == qid)
        res = client.post("/api/analyze", json={"question_id": q["id"], "answer": q["model_answer"]})
        self.assertEqual(res.status_code, 200)

    def _history(self, client):
        return client.get("/api/history").get_json()

    def test_register_logs_in_and_hashes_the_password(self):
        c = self._client()
        res = self._register(c, "hash@example.com")
        self.assertEqual(res.status_code, 201)
        self.assertEqual(c.get("/api/auth/me").get_json()["user"]["email"], "hash@example.com")
        stored = db.get_user_by_email("hash@example.com")["password_hash"]
        self.assertNotIn(self.PASSWORD, stored)
        self.assertNotIn("password_hash", res.get_json()["user"])

    def test_register_validates_input_and_rejects_duplicates(self):
        c = self._client()
        bad = c.post("/api/auth/register", json={"name": "", "email": "nope", "password": "short"})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(set(bad.get_json()["fields"]), {"name", "email", "password"})
        self.assertEqual(self._register(c, "dupe@example.com").status_code, 201)
        again = self._register(self._client(), "DUPE@example.com")
        self.assertEqual(again.status_code, 409)

    def test_login_logout_and_wrong_password(self):
        self._register(self._client(), "login@example.com")
        c = self._client()
        wrong = c.post("/api/auth/login", json={"email": "login@example.com", "password": "wrong password"})
        self.assertEqual(wrong.status_code, 401)
        unknown = c.post("/api/auth/login", json={"email": "nobody@example.com", "password": "whatever1"})
        self.assertEqual(unknown.get_json()["error"], wrong.get_json()["error"])  # no account enumeration
        ok = c.post("/api/auth/login", json={"email": "Login@Example.com", "password": self.PASSWORD})
        self.assertEqual(ok.status_code, 200)
        c.post("/api/auth/logout")
        self.assertIsNone(c.get("/api/auth/me").get_json()["user"])

    def test_repeated_failed_logins_are_rate_limited(self):
        self._register(self._client(), "limit@example.com")
        c = self._client()
        codes = [c.post("/api/auth/login", json={"email": "limit@example.com", "password": "bad guess"}).status_code
                 for _ in range(6)]
        self.assertEqual(codes[:5], [401] * 5)
        self.assertEqual(codes[5], 429)
        blocked = c.post("/api/auth/login", json={"email": "limit@example.com", "password": self.PASSWORD})
        self.assertEqual(blocked.status_code, 429)

    def test_history_is_private_to_each_user_and_guest(self):
        alice, bob, guest = self._client(), self._client(), self._client()
        self._register(alice, "alice@example.com")
        self._register(bob, "bob@example.com")
        self._attempt(alice)
        self.assertEqual(self._history(alice)["averages"]["n"], 1)
        self.assertEqual(self._history(bob)["averages"]["n"], 0)
        self.assertEqual(self._history(guest)["averages"]["n"], 0)
        bob.delete("/api/history")  # clearing only affects Bob
        self.assertEqual(self._history(alice)["averages"]["n"], 1)

    def test_guest_practice_moves_into_new_account(self):
        c = self._client()
        self._attempt(c)
        self._attempt(c)
        self.assertEqual(self._history(c)["averages"]["n"], 2)
        self._register(c, "guest-upgrade@example.com")
        self.assertEqual(self._history(c)["averages"]["n"], 2)

    def test_change_password(self):
        c = self._client()
        self._register(c, "change@example.com")
        wrong = c.post("/api/auth/password", json={"current": "not it at all", "new": "brand new pass"})
        self.assertEqual(wrong.status_code, 403)
        ok = c.post("/api/auth/password", json={"current": self.PASSWORD, "new": "brand new pass"})
        self.assertEqual(ok.status_code, 200)
        fresh = self._client()
        self.assertEqual(fresh.post("/api/auth/login", json={"email": "change@example.com",
                                                             "password": "brand new pass"}).status_code, 200)

    def test_changing_password_logs_out_other_devices(self):
        laptop, phone = self._client(), self._client()
        self._register(laptop, "devices@example.com")
        phone.post("/api/auth/login", json={"email": "devices@example.com", "password": self.PASSWORD})
        self.assertIsNotNone(phone.get("/api/auth/me").get_json()["user"])
        laptop.post("/api/auth/password", json={"current": self.PASSWORD, "new": "a new password"})
        self.assertIsNotNone(laptop.get("/api/auth/me").get_json()["user"])  # this device stays in
        self.assertIsNone(phone.get("/api/auth/me").get_json()["user"])      # the other is logged out

    def test_requests_do_not_resend_an_unchanged_session(self):
        # A slow request finishing after logout must not restore the session cookie.
        c = self._client()
        self._register(c, "cookie@example.com")
        self.assertNotIn("Set-Cookie", c.get("/api/history").headers)
        self.assertNotIn("Set-Cookie", c.get("/api/auth/me").headers)

    def test_delete_account_removes_user_and_attempts(self):
        c = self._client()
        self._register(c, "delete@example.com")
        self._attempt(c)
        uid = db.get_user_by_email("delete@example.com")["id"]
        self.assertEqual(c.delete("/api/auth/account", json={"password": "wrong one!"}).status_code, 403)
        self.assertEqual(c.delete("/api/auth/account", json={"password": self.PASSWORD}).status_code, 200)
        self.assertIsNone(db.get_user_by_email("delete@example.com"))
        self.assertEqual(db.history(db.Owner(user_id=uid))[1]["n"], 0)
        self.assertIsNone(c.get("/api/auth/me").get_json()["user"])

    def test_attempts_from_before_accounts_go_to_the_first_user(self):
        q = QUESTIONS[0]
        result = analyzer.analyze(q, q["model_answer"])
        db.save_attempt(q, q["model_answer"], result, db.Owner())  # no owner: a pre-accounts row
        self._register(self._client(), "legacy@example.com")
        uid = db.get_user_by_email("legacy@example.com")["id"]
        db.claim_legacy_attempts(uid)
        self.assertGreaterEqual(db.history(db.Owner(user_id=uid))[1]["n"], 1)


if __name__ == "__main__":
    unittest.main()
