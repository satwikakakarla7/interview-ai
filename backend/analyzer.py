"""NLP engine: scores an interview answer on clarity, confidence and relevance."""
import re

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    _vader = SentimentIntensityAnalyzer()
except ImportError:  # graceful fallback if vaderSentiment is missing
    _vader = None

FILLERS = ["um", "uh", "umm", "erm", "like", "you know", "basically", "actually",
           "literally", "sort of", "kind of", "i mean", "so yeah", "right"]
# Everyday phrases that contain a filler word but are not fillers, e.g. "I would like to",
# "RIGHT JOIN", "what kind of index". They are blanked out before fillers are counted.
_NOT_FILLER = re.compile(
    r"\b(?:would|'d|i|we|you|they|really|also|don't|didn't|do|did|to)\s+like\b"
    r"|\blike\s+to\b"
    r"|\b(?:look|looks|looked|feel|feels|felt|seem|seems|seemed|sound|sounds|sounded"
    r"|something|just|exactly|more|much)\s+like\b"
    r"|\bright\s+(?:join|joins|outer|child|subtree|side|now|away)\b"
    r"|\b(?:the|a|that's|is|was|be|turn|your|our|my)\s+right\b"
    r"|\b(?:what|which|this|that|the|any|some|same|every|each|one|a|different|new)\s+(?:kind|sort)\s+of\b"
)
HEDGES = ["maybe", "i guess", "i think", "probably", "perhaps", "might",
          "not sure", "i hope", "try to", "i suppose", "somewhat", "hopefully"]
# British spellings (organised, analysed, learnt) are included so Indian and UK English is not penalised.
ASSERTIVE = ["led", "built", "achieved", "delivered", "improved", "created", "designed",
             "implemented", "owned", "launched", "increased", "reduced", "resolved",
             "managed", "developed", "optimized", "optimised", "organized", "organised",
             "initiated", "solved"]
CONNECTORS = ["first", "second", "then", "next", "finally", "because", "therefore",
              "as a result", "for example", "for instance", "so that", "however", "in addition"]
STAR = {
    "Situation": ["when", "during", "at my", "in my", "while", "project", "team", "situation"],
    "Task": ["responsible", "goal", "task", "needed to", "had to", "objective", "challenge"],
    "Action": ["i built", "i led", "i decided", "i created", "i implemented", "i worked",
               "i developed", "i organized", "i organised", "i designed", "i analyzed",
               "i analysed", "i proposed"],
    "Result": ["result", "outcome", "achieved", "improved", "increased", "reduced",
               "learned", "learnt", "success", "%", "saved"],
}
# Questions where the candidate talks about themselves. Tone and action verbs are judged only
# here; technical explanations naturally use words such as "fails" or "noise" and describe
# concepts rather than personal actions.
SOFT_SKILL_CATEGORIES = {"HR", "Behavioral", "Situational"}
POS_WORDS = {"good", "great", "excited", "passionate", "love", "enjoy", "success", "confident",
             "improved", "achieved", "strong", "happy", "learned", "proud"}
NEG_WORDS = {"bad", "hate", "fail", "failed", "terrible", "worst", "boring", "difficult",
             "stress", "problem", "afraid", "nervous", "weak", "can't"}


def _tokens(text):
    return re.findall(r"[a-zA-Z']+", text.lower())


def _count_phrases(text, phrases):
    low = " " + text.lower() + " "
    found = {}
    for p in phrases:
        n = len(re.findall(r"(?<![a-z])" + re.escape(p) + r"(?![a-z])", low))
        if n:
            found[p] = n
    return found


def _count_fillers(text):
    return _count_phrases(_NOT_FILLER.sub(" ", text.lower()), FILLERS)


def keyword_terms(kw):
    """'lead|led|leader' -> ['lead', 'led', 'leader']. The first term is the display label."""
    return [t.strip() for t in str(kw).split("|") if t.strip()]


def keyword_label(kw):
    terms = keyword_terms(kw)
    return terms[0] if terms else str(kw)


def keyword_hit(kw, text):
    """Case-insensitive match at the start of a word, so 'lead' matches 'leadership'
    but 'put' does not match 'input'. Any alternative term counts."""
    low = text.lower()
    return any(re.search(r"(?<![a-z0-9])" + re.escape(t.lower()), low) for t in keyword_terms(kw))


def _clamp(x, lo=0, hi=100):
    return max(lo, min(hi, x))


def sentiment(text):
    if _vader:
        return _vader.polarity_scores(text)["compound"]
    toks = _tokens(text)
    if not toks:
        return 0.0
    score = sum(t in POS_WORDS for t in toks) - sum(t in NEG_WORDS for t in toks)
    return _clamp(score / max(len(toks) ** 0.5, 1), -1, 1)


def sentiment_label(c):
    return "Positive" if c >= 0.25 else "Negative" if c <= -0.25 else "Neutral"


def analyze(question, answer, duration=None):
    answer = (answer or "").strip()
    toks = _tokens(answer)
    words = len(toks)
    sentences = [s for s in re.split(r"[.!?]+", answer) if s.strip()]
    n_sent = max(len(sentences), 1)
    avg_len = words / n_sent
    fillers = _count_fillers(answer)
    hedges = _count_phrases(answer, HEDGES)
    assertive = [t for t in toks if t in ASSERTIVE]
    connectors = _count_phrases(answer, CONNECTORS)
    filler_total = sum(fillers.values())
    wpm = round(words / (duration / 60), 1) if duration and duration > 3 else None
    sent = sentiment(answer) if words else 0.0
    diversity = len(set(toks)) / words if words else 0
    soft = question.get("category") in SOFT_SKILL_CATEGORIES

    # ---- Clarity ----
    clarity = 100.0
    if words < 40:
        clarity -= (40 - words) * 1.2
    elif words > 280:
        clarity -= min((words - 280) * 0.15, 20)
    if avg_len > 26:
        clarity -= min((avg_len - 26) * 2, 20)
    elif avg_len < 7:
        clarity -= (7 - avg_len) * 3
    clarity -= min(filler_total / max(words, 1) * 300, 30)
    clarity -= max(0, (0.5 - diversity)) * 40
    clarity += min(sum(connectors.values()) * 3, 10)
    clarity = _clamp(clarity)

    # ---- Confidence ----
    # Technical answers start higher because they are judged on decisive wording
    # (no hedges or fillers) rather than on tone and action verbs.
    confidence = 60.0 if soft else 70.0
    confidence += min(len(assertive) * 4, 20)
    confidence -= min(sum(hedges.values()) * 6, 30)
    confidence -= min(filler_total * 3, 20)
    if soft:
        confidence += sent * 10
    first_person = toks.count("i") / max(words, 1)
    if 0.02 <= first_person <= 0.1:
        confidence += 5
    if wpm:
        if 110 <= wpm <= 160:
            confidence += 8
        elif wpm < 80 or wpm > 190:
            confidence -= 12
        else:
            confidence -= 4
    if words < 25:
        confidence -= 10
    confidence = _clamp(confidence)

    # ---- Relevance ----
    low = answer.lower()
    kws = question.get("keywords", [])
    hit = [keyword_label(k) for k in kws if keyword_hit(k, low)]
    miss = [keyword_label(k) for k in kws if not keyword_hit(k, low)]
    coverage = len(hit) / len(kws) if kws else 0.5
    sim = 0.0
    reference = question.get("model_answer") or question.get("ideal")
    if words >= 3 and reference:
        try:
            vec = TfidfVectorizer(stop_words="english", ngram_range=(1, 2))
            m = vec.fit_transform([reference, answer])
            sim = float(cosine_similarity(m[0], m[1])[0][0])
        except ValueError:
            sim = 0.0
    star_hits = {}
    if question.get("category") == "Behavioral":
        for k, ws in STAR.items():
            star_hits[k] = any(w in low for w in ws)
    relevance = coverage * 65 + min(sim * 180, 100) * 0.35
    if star_hits:
        relevance = relevance * 0.8 + (sum(star_hits.values()) / 4) * 20
    relevance = _clamp(relevance)
    if words < 15:
        relevance = min(relevance, 35)

    overall = round(clarity * 0.3 + confidence * 0.3 + relevance * 0.4)

    # ---- Feedback ----
    strengths, improve = [], []
    if clarity >= 75: strengths.append("Your answer was clear and easy to follow.")
    else: improve.append("Use shorter sentences and a clear structure (point, example, result).")
    if len(assertive) >= 2: strengths.append("Strong action verbs ('" + "', '".join(sorted(set(assertive))[:3]) + "') show ownership.")
    elif soft: improve.append("Use action verbs such as built, led, improved or delivered to show ownership.")
    if hedges: improve.append("Reduce hedging phrases: " + ", ".join(hedges) + ".")
    if filler_total >= 3: improve.append("Cut filler words (" + ", ".join(f"{k} x{v}" for k, v in fillers.items()) + "). Pause instead.")
    elif words: strengths.append("Very few filler words, which sounds composed.")
    if soft and sent >= 0.25: strengths.append("Positive, energetic tone.")
    elif soft and sent <= -0.25: improve.append("Your tone sounds negative; frame challenges around what you learned.")
    if wpm:
        if wpm > 170: improve.append(f"You spoke fast ({wpm} WPM). Aim for 110-160 WPM.")
        elif wpm < 100: improve.append(f"Your pace is slow ({wpm} WPM). Aim for 110-160 WPM.")
        else: strengths.append(f"Good speaking pace ({wpm} WPM).")
    if words < 40: improve.append("Answer is short. Aim for 60-200 words with a concrete example.")
    if words > 280: improve.append("Answer is long. Tighten it to about 2 minutes.")
    if hit and coverage >= 0.5: strengths.append("Covered key topics: " + ", ".join(hit[:5]) + ".")
    if miss and coverage < 0.7: improve.append("Consider mentioning: " + ", ".join(miss[:5]) + ".")
    missing_star = [k for k, v in star_hits.items() if not v]
    if missing_star: improve.append("Complete the STAR method; missing: " + ", ".join(missing_star) + ".")

    return {
        "overall": overall,
        "scores": {"clarity": round(clarity), "confidence": round(confidence), "relevance": round(relevance)},
        # "applies" is False for technical questions, where tone is not scored.
        "sentiment": {"compound": round(sent, 2), "label": sentiment_label(sent), "applies": soft},
        "metrics": {"words": words, "sentences": n_sent, "avg_sentence_length": round(avg_len, 1),
                    "wpm": wpm, "filler_count": filler_total, "fillers": fillers,
                    "hedges": hedges, "similarity": round(sim, 2)},
        "keywords": {"matched": hit, "missed": miss},
        "star": star_hits,
        "strengths": strengths,
        "improvements": improve,
    }
