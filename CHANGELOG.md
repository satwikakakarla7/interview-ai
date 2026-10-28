# Changelog

## 2.1.0

### Accounts
- **Log in, Create account and Account pages**, in the same design as the rest of the app.
- **Guest mode**: anyone can practice without an account. Guest history is private to the browser,
  and it moves into the account when the guest registers or logs in.
- **History is private per user**: Progress, the question bank's best scores and "Clear history" only
  show and affect your own attempts. Attempts saved before accounts existed go to the first account
  created on that install.
- Account page with profile details, change password (which logs out other devices) and delete
  account (removes all of the user's attempts).
- Security: scrypt password hashing, signed HttpOnly SameSite cookies (Secure when
  `INTERVIEWAI_SECURE_COOKIES=1`), login rate limiting, the same error for unknown emails and wrong
  passwords, and CORS off by default.
- Configuration through environment variables (secret key, database path, debug mode, host and port).

### Project
- GitHub Actions workflow runs the tests on Python 3.10 and 3.13.
- README with screenshots, an architecture diagram, setup, configuration, deployment, API and
  security notes; MIT license; `.gitignore` for local data and secrets.
- 11 new account tests (25 in total).

## 2.0.0

### Learning
- **Model answer after every attempt.** Feedback now includes a "Learn from a model answer"
  section: your answer and the model answer side by side, with each key concept highlighted, a
  checklist of concepts covered and missed, what interviewers look for, common mistakes and likely
  follow-up questions. The model answer is revealed only after you attempt the question.
- **Optional hint** before answering, which describes the approach without giving the answer away.
- **Try again** keeps your previous answer so you can improve it with what you learned.

### Questions
- Question bank expanded from 12 to **74 questions** across 10 topics: HR, Behavioral,
  Situational, Programming & OOP, Data Structures & Algorithms, Databases & SQL,
  OS & Networking, Web & APIs, Machine Learning and System Design.
- Every question has a difficulty level (Easy, Medium or Hard), a model answer, key concepts,
  three tips, common mistakes and two follow-up questions.
- Questions moved from `questions.py` to `backend/data/questions.json`, with validation at
  startup. Existing question ids 1-12 are unchanged, so saved history still links correctly.

### Website
- Removed the "How it works" page.
- New visual design with light and dark themes, a consistent type system (IBM Plex Sans and
  IBM Plex Serif, bundled for offline use) and a mobile layout.
- New **Question bank** page with search and filters by topic, difficulty and attempted status.
- Practice: topic and difficulty filters with question counts, a shuffled question deck with no
  repeats, "Question N of M", your best score per question, and Ctrl/Cmd + Enter to get feedback.
- Redesigned **Progress** page: summary stats, score trend chart (hover or arrow keys for
  details), average by topic with your weakest topic suggested, and every saved answer.
- Accessibility: keyboard navigation, visible focus, screen-reader labels, reduced-motion support
  and WCAG 2.1 AA color contrast (automated axe-core check passes on every page).
- Native dialog for clearing history, and clear messages for errors and empty states.

### Scoring
- Key concepts accept alternatives (`"lead|led|leadership"`) and match at the start of a word,
  so "led" counts for leadership and "put" no longer matches "input".
- Relevance compares your answer with the full model answer.
- Fewer false filler words: "I'd like to", "RIGHT JOIN" and "what kind of" are no longer counted.
- British spellings (organised, analysed, learnt) are recognized.
- Tone and action-verb feedback apply only to HR, Behavioral and Situational questions, so
  technical explanations aren't marked down for words such as "fails" or "noise".

### Backend
- `/api/analyze` returns a `learn` block (model answer, tips, mistakes, follow-ups, key concepts).
- `/api/history` adds per-question and per-topic statistics; `/api/questions` adds topic groups
  and difficulty filtering.
- Input validation and JSON error responses for the API; SQLite connections are now closed after use.
- Test suite in `backend/tests` (run `python -m unittest discover tests -v`).
