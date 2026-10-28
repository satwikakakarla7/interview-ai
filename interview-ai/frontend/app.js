/* InterviewAI front end. Plain JavaScript, no build step. */
(() => {
  "use strict";

  const API = "/api";
  const PRACTICE_KEY = "iai-practice";
  const THEME_KEY = "iai-theme";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    questions: [],          // public question views (no answers)
    byId: new Map(),
    groups: [],             // [{label, categories}]
    difficulties: ["Easy", "Medium", "Hard"],
    stats: {},              // question id -> {attempts, avg, best, last}
    filters: { category: "All", difficulty: "All" },
    deck: [],               // shuffled question ids for the current filters
    pos: 0,
    current: null,
    bank: { search: "", category: "All", difficulty: "All", status: "All" },
  };

  /* ---------- Utilities ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollBehavior = () => (reducedMotion() ? "auto" : "smooth");
  const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;
  const countIn = (cat) => state.questions.filter((q) => q.category === cat).length;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  const pending = new Set(); // requests in flight, so logging out can wait for them

  async function request(path, options) {
    let res;
    try {
      res = await fetch(API + path, options);
    } catch {
      throw new Error("Can't reach the InterviewAI server. Check that it's running, then try again.");
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `The server returned an error (${res.status}).`);
      err.status = res.status;
      err.fields = (data && data.fields) || {};
      throw err;
    }
    return data;
  }

  async function api(path, options) {
    const p = request(path, options);
    pending.add(p);
    try {
      return await p;
    } finally {
      pending.delete(p);
    }
  }
  const jsonBody = (method, body) => ({
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });

  const band = (score) => (score >= 70 ? "good" : score >= 50 ? "warn" : "bad");
  const ratingWord = (score) =>
    score >= 85 ? "Excellent" : score >= 70 ? "Strong" : score >= 50 ? "Developing" : "Needs work";
  const LEVEL = { Easy: 1, Medium: 2, Hard: 3 };
  const levelHTML = (d) =>
    `<span class="level" data-level="${LEVEL[d] || 2}" aria-hidden="true"><i></i><i></i><i></i></span>`;
  const ICON = {
    check: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    x: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  };

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const fmtClock = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined,
      { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const fmtShortDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

  /* Highlight one occurrence of each key concept. A concept is a list of accepted terms; a term
     matches at the start of a word and the mark extends to the end of that word, so "lead" marks
     "leadership" (the same rule the scorer uses). Text is escaped segment by segment. */
  function termRegex(term) {
    try {
      return new RegExp(`(?<![A-Za-z0-9])${reEsc(term)}[A-Za-z0-9'-]*`, "gi");
    } catch {
      return new RegExp(`\\b${reEsc(term)}[A-Za-z0-9'-]*`, "gi"); // browsers without lookbehind
    }
  }

  function highlightConcepts(text, conceptTerms) {
    const src = String(text ?? "");
    const taken = [];
    const overlaps = (s, e) => taken.some((r) => s < r.end && e > r.start);
    for (const terms of conceptTerms || []) {
      const matches = [];
      for (const t of terms) {
        for (const m of src.matchAll(termRegex(t))) {
          if (m[0]) matches.push({ start: m.index, end: m.index + m[0].length });
        }
      }
      matches.sort((a, b) => a.start - b.start || b.end - a.end);
      const first = matches.find((r) => !overlaps(r.start, r.end));
      if (first) taken.push(first);
    }
    taken.sort((a, b) => a.start - b.start);
    let out = "";
    let pos = 0;
    for (const r of taken) {
      out += esc(src.slice(pos, r.start)) + `<mark class="hl">${esc(src.slice(r.start, r.end))}</mark>`;
      pos = r.end;
    }
    return out + esc(src.slice(pos));
  }

  /* ---------- Tooltip (charts) ---------- */
  const tooltip = {
    show(html, x, y) {
      const el = $("#tooltip");
      el.innerHTML = html;
      el.hidden = false;
      const r = el.getBoundingClientRect();
      let left = x - r.width / 2;
      let top = y - r.height - 14;
      left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
      if (top < 8) top = y + 16;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    },
    hide() { $("#tooltip").hidden = true; },
  };

  /* ---------- Theme ---------- */
  const theme = {
    current() {
      const t = document.documentElement.dataset.theme;
      if (t) return t;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    },
    init() {
      const btn = $("#themeToggle");
      const sync = () => {
        const label = theme.current() === "dark" ? "Switch to light theme" : "Switch to dark theme";
        btn.setAttribute("aria-label", label);
        btn.title = label;
      };
      btn.addEventListener("click", () => {
        const next = theme.current() === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
        sync();
      });
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", sync);
      sync();
    },
  };

  /* ---------- Toast (confirms an action) ---------- */
  const toast = {
    timer: null,
    show(message) {
      const el = $("#toast");
      el.hidden = true;
      el.textContent = message;
      requestAnimationFrame(() => { el.hidden = false; });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { el.hidden = true; }, 4000);
    },
  };

  /* ---------- Router (#/practice, #/bank, #/progress, #/login, #/register, #/account) ---------- */
  const router = {
    view: null,
    routes: ["practice", "bank", "progress", "login", "register", "account"],
    titles: {
      practice: "Practice", bank: "Question bank", progress: "Progress",
      login: "Log in", register: "Create account", account: "Account",
    },
    init() {
      window.addEventListener("hashchange", () => this.go());
      this.go(true);
    },
    go(initial = false) {
      const name = (location.hash.match(/^#\/(\w+)/) || [])[1];
      // Ignore in-page anchors such as "#main" from the skip link.
      if (!name && !initial && this.view && location.hash) return;
      const view = this.routes.includes(name) ? name : "practice";
      const authView = view === "login" || view === "register";
      if (view === "account" && !auth.user) {
        this.guardReturn = "account"; // come back here after logging in
        location.replace("#/login");
        return;
      }
      if (authView && auth.user) {
        location.replace("#/account");
        return;
      }
      if (view === this.view) return;
      if (authView) {
        if (this.guardReturn) auth.returnTo = this.guardReturn;
        else if (this.view && !["login", "register"].includes(this.view)) auth.returnTo = this.view;
        this.guardReturn = null;
      }
      this.view = view;
      this.routes.forEach((r) => { $(`#view-${r}`).hidden = r !== view; });
      $$(".nav a, .account-link").forEach((a) => {
        const route = a.dataset.route || "account";
        if (route === view) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
      document.title = `${this.titles[view]} - InterviewAI`;
      tooltip.hide();
      if (view !== "practice") recorder.stop(true);
      if (view === "bank") bank.renderList();
      if (view === "progress") progress.load();
      if (view === "account") account.render();
      if (authView) forms.reset($(`#${view}Form`));
      if (!initial) {
        window.scrollTo(0, 0);
        const h = $(`#view-${view} h1`);
        if (h) h.focus({ preventScroll: true });
      }
    },
  };

  /* ---------- Voice input ---------- */
  const recorder = {
    SR: window.SpeechRecognition || window.webkitSpeechRecognition,
    rec: null,
    listening: false,
    base: "",
    finalText: "",
    started: 0,
    seconds: 0,
    usedVoice: false,
    timerId: null,

    init() {
      $("#recBtn").addEventListener("click", () => (this.listening ? this.stop() : this.start()));
      $("#uploadBtn").addEventListener("click", () => $("#audioFile").click());
      $("#audioFile").addEventListener("change", (e) => this.upload(e));
      if (!this.SR) $("#recBtn").title = "Voice input works in Chrome and Edge";
    },
    status(msg) { $("#recStatus").textContent = msg; },

    start() {
      if (!this.SR) {
        this.status("Voice input isn't available in this browser. Use Chrome or Edge, type your answer, or upload a WAV file.");
        return;
      }
      const rec = new this.SR();
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      this.base = $("#answer").value.trim();
      this.finalText = "";

      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) this.finalText += `${t} `;
          else interim += t;
        }
        $("#answer").value = `${this.base} ${this.finalText}${interim}`.replace(/\s+/g, " ").trim();
        practice.updateCount();
      };
      rec.onerror = (e) => {
        if (e.error === "aborted") return;
        const messages = {
          "not-allowed": "Microphone access is blocked. Allow it in your browser's site settings, then try again.",
          "service-not-allowed": "Microphone access is blocked. Allow it in your browser's site settings, then try again.",
          "no-speech": "No speech was detected. Check your microphone and try again.",
          "audio-capture": "No microphone was found. Connect one, or type your answer instead.",
          network: "Voice input needs an internet connection. Type your answer, or try again when you're online.",
        };
        this.stop(true);
        this.status(messages[e.error] || `Voice input stopped (${e.error}). Try again or type your answer.`);
      };
      // Chrome ends a session after a pause; keep listening until the user stops.
      rec.onend = () => {
        if (!this.listening) return;
        try { rec.start(); } catch { this.stop(); }
      };

      try {
        rec.start();
      } catch {
        this.status("Couldn't start voice input. Try again.");
        return;
      }
      this.rec = rec;
      this.listening = true;
      this.usedVoice = true;
      this.started = Date.now();
      this.timerId = setInterval(() => {
        $("#timer").textContent = fmtClock(this.seconds + (Date.now() - this.started) / 1000);
      }, 250);
      const btn = $("#recBtn");
      btn.classList.add("live");
      btn.setAttribute("aria-pressed", "true");
      $("#recLabel").textContent = "Stop recording";
      this.status("Listening. Speak your answer, then stop recording.");
    },

    stop(silent = false) {
      if (!this.listening) return;
      this.listening = false;
      try { if (this.rec) this.rec.stop(); } catch { /* already stopped */ }
      clearInterval(this.timerId);
      this.seconds += (Date.now() - this.started) / 1000;
      $("#timer").textContent = fmtClock(this.seconds);
      const btn = $("#recBtn");
      btn.classList.remove("live");
      btn.setAttribute("aria-pressed", "false");
      $("#recLabel").textContent = "Start speaking";
      if (!silent) this.status("Recording stopped. Edit the text if you need to, then get feedback.");
    },

    reset() {
      this.stop(true);
      this.seconds = 0;
      this.usedVoice = false;
      $("#timer").textContent = "00:00";
    },

    async upload(e) {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      this.stop(true);
      this.status("Transcribing your audio…");
      const fd = new FormData();
      fd.append("audio", file);
      try {
        const data = await api("/transcribe", { method: "POST", body: fd });
        $("#answer").value = data.text;
        this.seconds = data.duration || 0;
        this.usedVoice = true;
        $("#timer").textContent = fmtClock(this.seconds);
        practice.updateCount();
        this.status("Transcription complete. Review the text, then get feedback.");
      } catch (err) {
        this.status(err.message);
      }
    },
  };

  /* ---------- Practice ---------- */
  const practice = {
    init() {
      const cat = $("#category");
      cat.innerHTML = `<option value="All">All topics (${state.questions.length})</option>` +
        state.groups.map((g) => `<optgroup label="${esc(g.label)}">${g.categories
          .map((c) => `<option value="${esc(c)}">${esc(c)} (${countIn(c)})</option>`).join("")}</optgroup>`).join("");

      const saved = store.get(PRACTICE_KEY, null);
      if (saved && (saved.category === "All" || countIn(saved.category))) state.filters.category = saved.category;
      if (saved && (saved.difficulty === "All" || state.difficulties.includes(saved.difficulty))) {
        state.filters.difficulty = saved.difficulty;
      }
      cat.value = state.filters.category;
      this.refreshDifficulty();

      cat.addEventListener("change", () => this.setFilters({ category: cat.value }));
      $("#difficulty").addEventListener("change", (e) => this.setFilters({ difficulty: e.target.value }));
      $("#skipBtn").addEventListener("click", () => this.next());
      $("#nextBtn").addEventListener("click", () => this.next(true));
      $("#retryBtn").addEventListener("click", () => this.retry());
      $("#hintBtn").addEventListener("click", () => this.setHint($("#hint").hidden));
      $("#analyzeBtn").addEventListener("click", () => this.submit());
      const answer = $("#answer");
      answer.addEventListener("input", () => this.updateCount());
      answer.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.submit(); }
      });
      if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
        $(".shortcut kbd").textContent = "⌘";
      }
      $("#qText").tabIndex = -1;

      this.buildDeck();
      this.show();
    },

    /* Difficulty options show how many questions each level has in the chosen topic. */
    refreshDifficulty() {
      const sel = $("#difficulty");
      const inCat = state.questions.filter((q) => state.filters.category === "All" || q.category === state.filters.category);
      const count = (d) => inCat.filter((q) => q.difficulty === d).length;
      if (state.filters.difficulty !== "All" && !count(state.filters.difficulty)) state.filters.difficulty = "All";
      sel.innerHTML = `<option value="All">All levels (${inCat.length})</option>` + state.difficulties
        .map((d) => `<option value="${d}"${count(d) ? "" : " disabled"}>${d} (${count(d)})</option>`).join("");
      sel.value = state.filters.difficulty;
    },

    pool() {
      const f = state.filters;
      return state.questions.filter((q) =>
        (f.category === "All" || q.category === f.category) &&
        (f.difficulty === "All" || q.difficulty === f.difficulty));
    },

    buildDeck(firstId) {
      let ids = shuffle(this.pool().map((q) => q.id));
      if (firstId != null && ids.includes(firstId)) ids = [firstId, ...ids.filter((id) => id !== firstId)];
      state.deck = ids;
      state.pos = 0;
    },

    setFilters(patch) {
      Object.assign(state.filters, patch);
      if ("category" in patch) this.refreshDifficulty();
      store.set(PRACTICE_KEY, state.filters);
      this.buildDeck();
      this.show();
    },

    /* Switch to one topic, optionally starting with a specific question. */
    useTopic(category, firstId) {
      state.filters = { category, difficulty: "All" };
      $("#category").value = category;
      this.refreshDifficulty();
      store.set(PRACTICE_KEY, state.filters);
      this.buildDeck(firstId);
      this.show();
    },

    /* Open a specific question (from the question bank or history). */
    start(id) {
      const q = state.byId.get(id);
      if (q) this.useTopic(q.category, id);
    },

    next(scrollUp = false) {
      if (!state.deck.length) return;
      state.pos += 1;
      if (state.pos >= state.deck.length) {
        const last = state.current && state.current.id;
        this.buildDeck();
        if (state.deck.length > 1 && state.deck[0] === last) [state.deck[0], state.deck[1]] = [state.deck[1], state.deck[0]];
      }
      this.show();
      if (scrollUp) {
        $(".toolbar").scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        $("#qText").focus({ preventScroll: true });
      }
    },

    show() {
      const q = state.byId.get(state.deck[state.pos]) || null;
      state.current = q;
      recorder.reset();
      $("#results").hidden = true;
      $("#error").textContent = "";
      $("#recStatus").textContent = "";
      $("#answer").value = "";
      this.updateCount();
      this.setHint(false);

      const hasQ = Boolean(q);
      $("#hintBtn").disabled = !hasQ || !q.hint;
      $("#skipBtn").disabled = state.deck.length < 2;
      $("#analyzeBtn").disabled = !hasQ;
      if (!hasQ) {
        $("#qTags").innerHTML = "";
        $("#qText").textContent = "No questions match these filters. Choose another topic or difficulty.";
        $("#qBest").textContent = "";
        $("#counter").textContent = "";
        return;
      }
      $("#qTags").innerHTML = `<span class="tag">${esc(q.category)}</span>` +
        `<span class="tag">${levelHTML(q.difficulty)}${esc(q.difficulty)}</span>`;
      $("#qText").textContent = q.question;
      $("#hintText").textContent = q.hint || "";
      $("#counter").textContent = `Question ${state.pos + 1} of ${state.deck.length}`;
      this.showBest();
    },

    showBest() {
      const s = state.current && state.stats[state.current.id];
      $("#qBest").textContent = s ? `Your best score: ${s.best} from ${plural(s.attempts, "attempt")}` : "";
    },

    setHint(open) {
      $("#hint").hidden = !open;
      const btn = $("#hintBtn");
      btn.setAttribute("aria-expanded", String(open));
      btn.querySelector("span").textContent = open ? "Hide hint" : "Show hint";
    },

    words() { return $("#answer").value.trim().split(/\s+/).filter(Boolean).length; },
    updateCount() { $("#wordCount").textContent = plural(this.words(), "word"); },

    async submit() {
      if (!state.current) return;
      recorder.stop(true);
      const err = $("#error");
      err.textContent = "";
      if (this.words() < 3) {
        err.textContent = "Write or say at least a few words before getting feedback.";
        $("#answer").focus();
        return;
      }
      const answer = $("#answer").value.trim();
      const btn = $("#analyzeBtn");
      btn.disabled = true;
      btn.textContent = "Analyzing…";
      try {
        const data = await api("/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question_id: state.current.id,
            answer,
            duration: recorder.usedVoice ? recorder.seconds : null,
          }),
        });
        this.recordStat(state.current.id, data.overall);
        results.render(data, answer);
      } catch (e) {
        err.textContent = e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = "Get feedback";
      }
    },

    recordStat(id, score) {
      const s = state.stats[id] || { attempts: 0, avg: 0, best: 0 };
      s.avg = Math.round(((s.avg * s.attempts + score) / (s.attempts + 1)) * 10) / 10;
      s.attempts += 1;
      s.best = Math.max(s.best, score);
      s.last = new Date().toISOString();
      state.stats[id] = s;
      this.showBest();
    },

    /* Keep the previous answer so the learner can improve it with what they just learned. */
    retry() {
      $("#results").hidden = true;
      recorder.reset();
      $(".practice").scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      const ta = $("#answer");
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
      recorder.status("Improve your answer using what you learned, then get feedback again.");
    },
  };

  /* ---------- Feedback and learning ---------- */
  const results = {
    criteria: [
      ["clarity", "Clarity", "Structure, sentence length and filler words"],
      ["confidence", "Confidence", "Decisive wording, hedging and pace"],
      ["relevance", "Relevance", "Key concepts and match with the model answer"],
    ],

    render(r, answer) {
      const learn = r.learn || {};

      $("#overallScore").textContent = r.overall;
      const ov = $("#overallRating");
      ov.textContent = ratingWord(r.overall);
      ov.dataset.band = band(r.overall);

      $("#criteria").innerHTML = this.criteria.map(([key, name, desc]) => {
        const v = r.scores[key];
        return `<div class="criterion" data-band="${band(v)}">
          <span class="criterion-name">${name}<span class="criterion-desc">${desc}</span></span>
          <span class="meter" role="meter" aria-label="${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}"><span data-w="${v}"></span></span>
          <span class="criterion-value">${v}</span>
          <span class="rating">${ratingWord(v)}</span>
        </div>`;
      }).join("");

      const m = r.metrics;
      const metrics = [
        ["Words", m.words],
        ["Pace", m.wpm ? `${Math.round(m.wpm)}<small>wpm</small>` : `–<small>typed</small>`],
        ["Filler words", m.filler_count],
        ["Avg sentence", `${m.avg_sentence_length}<small>words</small>`],
        ["Model match", `${Math.round(m.similarity * 100)}%`],
        // Tone is only scored for HR, behavioral and situational answers.
        r.sentiment.applies === false ? ["Sentences", m.sentences] : ["Tone", esc(r.sentiment.label)],
      ];
      $("#metrics").innerHTML = metrics.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");

      const fill = (sel, items, fallback) => {
        $(sel).innerHTML = (items && items.length ? items : [fallback]).map((t) => `<li>${esc(t)}</li>`).join("");
      };
      fill("#strengths", r.strengths, "Keep practicing to build strengths.");
      fill("#improvements", r.improvements, "Nothing major to fix. Try a harder question next.");

      // Learn from a model answer
      const groups = learn.concept_terms || [];
      $("#yourAnswer").innerHTML = highlightConcepts(answer, groups);
      const model = $("#modelAnswer");
      model.innerHTML = learn.model_answer
        ? highlightConcepts(learn.model_answer, groups)
        : "No model answer is available for this question yet.";

      const hit = new Set((r.keywords.matched || []).map((k) => k.toLowerCase()));
      const concepts = learn.concepts || [...(r.keywords.matched || []), ...(r.keywords.missed || [])];
      $("#concepts").innerHTML = concepts.map((c) => (hit.has(c.toLowerCase())
        ? `<li class="chip hit">${ICON.check}<span>${esc(c)}</span><span class="sr-only">(covered)</span></li>`
        : `<li class="chip miss">${ICON.x}<span>${esc(c)}</span><span class="sr-only">(missing)</span></li>`)).join("");

      const star = Object.entries(r.star || {});
      $("#starRow").hidden = !star.length;
      $("#star").innerHTML = star.map(([k, ok]) =>
        `<li class="chip ${ok ? "hit" : "miss"}">${ok ? ICON.check : ICON.x}<span>${esc(k)}</span><span class="sr-only">(${ok ? "present" : "missing"})</span></li>`).join("");

      const list = (sel, items) => {
        $(sel).innerHTML = (items || []).map((t) => `<li>${esc(t)}</li>`).join("");
        $(sel).parentElement.hidden = !(items && items.length);
      };
      list("#tips", learn.tips);
      list("#mistakes", learn.mistakes);
      list("#followUps", learn.follow_ups);

      const section = $("#results");
      section.hidden = false;
      requestAnimationFrame(() => {
        $$("#criteria .meter > span").forEach((el) => { el.style.width = `${el.dataset.w}%`; });
      });
      this.drawHighlights(model);
      section.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      $("#resultsTitle").focus({ preventScroll: true });
    },

    /* The one orchestrated moment: key concepts in the model answer are highlighted
       left to right when the answer scrolls into view. */
    drawHighlights(el) {
      if (this.observer) this.observer.disconnect();
      el.classList.remove("draw", "drawn");
      if (reducedMotion() || !("IntersectionObserver" in window)) return;
      $$("mark.hl", el).forEach((mk, i) => { mk.style.transitionDelay = `${Math.min(i * 80, 1600)}ms`; });
      el.classList.add("draw");
      this.observer = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        this.observer.disconnect();
        requestAnimationFrame(() => el.classList.add("drawn"));
      }, { threshold: 0.4 });
      this.observer.observe(el);
    },
  };

  /* ---------- Question bank ---------- */
  const bank = {
    init() {
      const cats = [["All", "All topics", state.questions.length],
        ...state.groups.flatMap((g) => g.categories.map((c) => [c, c, countIn(c)]))];
      $("#bankCats").innerHTML = cats.map(([v, label, n]) =>
        `<button type="button" class="filter-chip" data-value="${esc(v)}" aria-pressed="${v === "All"}">${esc(label)} <span class="count">${n}</span></button>`).join("");
      $("#bankDiff").innerHTML = [["All", "All levels"], ...state.difficulties.map((d) => [d, d])]
        .map(([v, l]) => `<button type="button" data-value="${v}" aria-pressed="${v === "All"}">${l}</button>`).join("");
      $("#bankStatus").innerHTML = [["All", "All"], ["New", "Not attempted"], ["Done", "Attempted"]]
        .map(([v, l]) => `<button type="button" data-value="${v}" aria-pressed="${v === "All"}">${l}</button>`).join("");

      const bindGroup = (sel, key) => $(sel).addEventListener("click", (e) => {
        const b = e.target.closest("button[data-value]");
        if (!b) return;
        state.bank[key] = b.dataset.value;
        this.syncPressed(sel, b.dataset.value);
        this.renderList();
      });
      bindGroup("#bankCats", "category");
      bindGroup("#bankDiff", "difficulty");
      bindGroup("#bankStatus", "status");
      $("#bankSearch").addEventListener("input", debounce((e) => {
        state.bank.search = e.target.value;
        this.renderList();
      }, 120));
      $("#bankList").addEventListener("click", (e) => {
        const row = e.target.closest(".bank-row");
        if (row) { practice.start(Number(row.dataset.id)); location.hash = "#/practice"; return; }
        if (e.target.closest("#bankReset")) this.reset();
      });
    },

    syncPressed(sel, value) {
      $$(`${sel} button[data-value]`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
    },

    reset() {
      state.bank = { search: "", category: "All", difficulty: "All", status: "All" };
      $("#bankSearch").value = "";
      ["#bankCats", "#bankDiff", "#bankStatus"].forEach((sel) => this.syncPressed(sel, "All"));
      this.renderList();
    },

    renderList() {
      const f = state.bank;
      const term = f.search.trim().toLowerCase();
      const rows = state.questions.filter((q) =>
        (f.category === "All" || q.category === f.category) &&
        (f.difficulty === "All" || q.difficulty === f.difficulty) &&
        (f.status === "All" || (f.status === "Done") === Boolean(state.stats[q.id])) &&
        (!term || q.question.toLowerCase().includes(term) || q.category.toLowerCase().includes(term)));

      const topics = state.groups.reduce((n, g) => n + g.categories.length, 0);
      const practiced = state.questions.filter((q) => state.stats[q.id]).length;
      $("#bankSummary").textContent =
        `${state.questions.length} questions across ${topics} topics. You've practiced ${practiced} so far.`;

      if (!rows.length) {
        $("#bankList").innerHTML = `<div class="bank-empty"><p>No questions match these filters.</p>
          <button type="button" class="btn secondary" id="bankReset">Clear filters</button></div>`;
        return;
      }
      const grouped = new Map();
      rows.forEach((q) => {
        if (!grouped.has(q.category)) grouped.set(q.category, []);
        grouped.get(q.category).push(q);
      });
      $("#bankList").innerHTML = [...grouped].map(([cat, qs]) => {
        const done = state.questions.filter((q) => q.category === cat && state.stats[q.id]).length;
        return `<section class="bank-group" aria-label="${esc(cat)}">
          <div class="bank-group-head"><h2>${esc(cat)}</h2><p>${done} of ${countIn(cat)} practiced</p></div>
          <ul class="bank-rows">${qs.map((q) => this.row(q)).join("")}</ul>
        </section>`;
      }).join("");
    },

    row(q) {
      const st = state.stats[q.id];
      const status = st
        ? `<span class="bank-status done" data-band="${band(st.best)}">Best ${st.best}</span>`
        : `<span class="bank-status">Not attempted</span>`;
      return `<li><button type="button" class="bank-row" data-id="${q.id}">
        <span class="bank-q">${esc(q.question)}</span>
        <span class="bank-level">${levelHTML(q.difficulty)}${esc(q.difficulty)}</span>
        ${status}
        <span class="bank-go" aria-hidden="true">Practice</span>
      </button></li>`;
    },
  };

  /* ---------- Progress ---------- */
  const progress = {
    data: null,

    init() {
      $("#clearBtn").addEventListener("click", () => this.confirmClear());
      $("#progressData").addEventListener("click", (e) => {
        const b = e.target.closest("[data-practice]");
        if (b) { practice.start(Number(b.dataset.practice)); location.hash = "#/practice"; return; }
        const t = e.target.closest("[data-topic]");
        if (t) { practice.useTopic(t.dataset.topic); location.hash = "#/practice"; }
      });
      window.addEventListener("resize", debounce(() => {
        if (router.view === "progress" && this.data) this.drawTrend();
      }, 150));
    },

    async load() {
      const empty = $("#progressEmpty");
      try {
        const d = await api("/history?limit=50");
        this.data = d;
        state.stats = d.by_question || {};
        empty.querySelector("h2").textContent = "No attempts yet";
        empty.querySelector("p").textContent = "Answer a question to see your scores, trends and weakest topics here.";
        this.render();
      } catch (e) {
        this.data = null;
        $("#progressData").hidden = true;
        $("#clearBtn").hidden = true;
        $("#guestNotice").hidden = true;
        empty.hidden = false;
        empty.querySelector("h2").textContent = "Couldn't load your progress";
        empty.querySelector("p").textContent = e.message;
      }
    },

    render() {
      const d = this.data;
      const a = d.averages;
      const has = a.n > 0;
      $("#progressEmpty").hidden = has;
      $("#progressData").hidden = !has;
      $("#clearBtn").hidden = !has;
      $("#guestNotice").hidden = !has || Boolean(auth.user);
      if (!has) return;
      $("#statStrip").innerHTML = [
        ["Attempts", a.n],
        ["Questions practiced", `${a.questions}<small>of ${d.total_questions}</small>`],
        ["Average score", Math.round(a.overall)],
        ["Best score", a.best],
      ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
      this.drawTrend();
      this.drawTopics();
      this.drawHistory();
    },

    drawTrend() {
      const host = $("#trend");
      const pts = this.data.attempts.slice(0, 30).reverse(); // oldest to newest
      $("#trendNote").textContent = pts.length > 1
        ? `Overall score for your last ${pts.length} attempts, oldest to newest.`
        : "Overall score for each attempt.";
      if (pts.length < 2) {
        host.innerHTML = `<p class="trend-empty">Complete at least two attempts to see your trend.</p>`;
        host.removeAttribute("tabindex");
        host.removeAttribute("role");
        host.removeAttribute("aria-label");
        return;
      }

      const W = Math.max(host.clientWidth, 260);
      const H = 240;
      const m = { t: 12, r: 34, b: 28, l: 30 };
      const iw = W - m.l - m.r;
      const ih = H - m.t - m.b;
      const x = (i) => m.l + (i / (pts.length - 1)) * iw;
      const y = (v) => m.t + ih - (v / 100) * ih;
      const last = pts[pts.length - 1];
      const scores = pts.map((p) => p.overall);

      let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">`;
      [0, 25, 50, 75, 100].forEach((v) => {
        svg += `<line class="${v === 0 ? "axis-line" : "grid-line"}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
        svg += `<text class="axis-text" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
      });
      const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.overall).toFixed(1)}`).join("");
      svg += `<path class="trend-area" d="${line}L${x(pts.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z"/>`;
      svg += `<path class="trend-line" d="${line}"/>`;
      svg += `<line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
      svg += pts.map((p, i) => `<circle class="trend-dot" cx="${x(i).toFixed(1)}" cy="${y(p.overall).toFixed(1)}" r="4"/>`).join("");
      svg += `<text class="axis-text" x="${x(0)}" y="${H - 6}" text-anchor="start">${esc(fmtShortDate(pts[0].created))}</text>`;
      svg += `<text class="axis-text" x="${x(pts.length - 1)}" y="${H - 6}" text-anchor="end">${esc(fmtShortDate(last.created))}</text>`;
      svg += `<text class="end-label" x="${x(pts.length - 1) + 9}" y="${y(last.overall) + 4}">${last.overall}</text>`;
      svg += `</svg><p class="sr-only" aria-live="polite"></p>`;
      host.innerHTML = svg;
      host.tabIndex = 0;
      host.setAttribute("role", "group");
      host.setAttribute("aria-label",
        `Score trend over ${pts.length} attempts. Latest ${last.overall}, highest ${Math.max(...scores)}, lowest ${Math.min(...scores)}. Use the left and right arrow keys to read each attempt.`);

      const svgEl = $("svg", host);
      const cross = $(".crosshair", host);
      const dots = $$(".trend-dot", host);
      const live = $("p.sr-only", host);
      let active = -1;
      const show = (i, announce = false) => {
        active = i;
        const p = pts[i];
        cross.setAttribute("x1", x(i));
        cross.setAttribute("x2", x(i));
        cross.setAttribute("visibility", "visible");
        dots.forEach((dot, j) => {
          dot.setAttribute("r", j === i ? 6 : 4);
          dot.classList.toggle("active", j === i);
        });
        const rect = svgEl.getBoundingClientRect();
        const k = rect.width / W;
        tooltip.show(`<strong>${p.overall} ${esc(ratingWord(p.overall).toLowerCase())}</strong>${esc(truncate(p.question, 72))}<br>${esc(fmtDate(p.created))}`,
          rect.left + x(i) * k, rect.top + y(p.overall) * k);
        if (announce) live.textContent = `Attempt ${i + 1} of ${pts.length}: score ${p.overall}. ${p.question}. ${fmtDate(p.created)}.`;
      };
      const hide = () => {
        active = -1;
        cross.setAttribute("visibility", "hidden");
        dots.forEach((dot) => { dot.setAttribute("r", 4); dot.classList.remove("active"); });
        tooltip.hide();
      };
      svgEl.addEventListener("pointermove", (e) => {
        const rect = svgEl.getBoundingClientRect();
        const px = (e.clientX - rect.left) * (W / rect.width);
        const i = Math.round(((px - m.l) / iw) * (pts.length - 1));
        show(Math.max(0, Math.min(pts.length - 1, i)));
      });
      svgEl.addEventListener("pointerleave", hide);
      host.onfocus = () => show(pts.length - 1, true);
      host.onblur = hide;
      host.onkeydown = (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const step = e.key === "ArrowRight" ? 1 : -1;
          show(Math.max(0, Math.min(pts.length - 1, (active < 0 ? pts.length - 1 : active) + step)), true);
        } else if (e.key === "Escape") {
          hide();
        }
      };
    },

    drawTopics() {
      const bestIn = (cat) => Math.max(0, ...state.questions
        .filter((q) => q.category === cat && state.stats[q.id]).map((q) => state.stats[q.id].best));
      const topics = this.data.by_category;
      const ul = $("#topicBars");
      ul.innerHTML = topics.map((c) => {
        if (!c.attempts) {
          return `<li class="topic none"><span class="topic-name">${esc(c.category)}<small>${plural(c.questions, "question")}</small></span>
            <span class="topic-none">Not started</span><span></span></li>`;
        }
        const avg = Math.round(c.avg);
        return `<li class="topic" tabindex="0" data-cat="${esc(c.category)}" data-avg="${avg}" data-best="${bestIn(c.category)}" data-attempts="${c.attempts}" data-practiced="${c.practiced}" data-questions="${c.questions}">
          <span class="topic-name">${esc(c.category)}<small>${c.practiced} of ${c.questions} practiced</small></span>
          <span class="topic-track"><span style="width:${avg}%"></span></span>
          <span class="topic-value">${avg}</span>
        </li>`;
      }).join("");

      // Suggest the weakest topic once at least two topics have been tried.
      const tried = topics.filter((c) => c.attempts);
      const old = $("#topicFocus");
      if (old) old.remove();
      if (tried.length >= 2) {
        const weakest = tried.reduce((a, b) => (b.avg < a.avg ? b : a));
        ul.insertAdjacentHTML("afterend", `<div class="topic-focus" id="topicFocus">
          <p class="section-note">Your lowest average is in ${esc(weakest.category)} (${Math.round(weakest.avg)}).</p>
          <button type="button" class="btn ghost small" data-topic="${esc(weakest.category)}">Practice ${esc(weakest.category)}</button>
        </div>`);
      }

      const showTip = (li) => {
        const r = li.querySelector(".topic-track").getBoundingClientRect();
        const ds = li.dataset;
        tooltip.show(`<strong>${ds.avg} average</strong>${esc(ds.cat)}: best ${ds.best}, ${plural(Number(ds.attempts), "attempt")} on ${ds.practiced} of ${ds.questions} questions`,
          r.left + (r.width * Number(ds.avg)) / 100, r.top);
      };
      $$(".topic[data-cat]", ul).forEach((li) => {
        li.addEventListener("pointerenter", () => showTip(li));
        li.addEventListener("pointerleave", () => tooltip.hide());
        li.addEventListener("focus", () => showTip(li));
        li.addEventListener("blur", () => tooltip.hide());
      });
    },

    drawHistory() {
      $("#historyList").innerHTML = this.data.attempts.map((a) => `<li>
        <div class="h-score" data-band="${band(a.overall)}">${a.overall}<span>${ratingWord(a.overall)}</span></div>
        <div>
          <p class="h-q">${esc(a.question)}</p>
          <p class="h-meta"><span class="tag">${esc(a.category)}</span><span>${esc(fmtDate(a.created))}</span></p>
          <p class="h-sub">Clarity ${a.clarity}, confidence ${a.confidence}, relevance ${a.relevance}</p>
          <details>
            <summary>Show my answer</summary>
            <p class="h-answer">${esc(a.answer)}</p>
            ${state.byId.has(a.question_id) ? `<button type="button" class="btn secondary small" data-practice="${a.question_id}">Practice this question again</button>` : ""}
          </details>
        </div>
      </li>`).join("");
    },

    confirmClear() {
      const dlg = $("#confirmDialog");
      if (typeof dlg.showModal !== "function") {
        if (window.confirm("Clear all practice history? This can't be undone.")) this.clear();
        return;
      }
      $("#confirmText").textContent = auth.user
        ? "This deletes every attempt and score saved to your account. It can't be undone."
        : "This deletes every attempt and score saved in this browser. It can't be undone.";
      dlg.returnValue = "";
      dlg.addEventListener("close", () => { if (dlg.returnValue === "confirm") this.clear(); }, { once: true });
      dlg.showModal();
    },

    async clear() {
      try {
        await api("/history", { method: "DELETE" });
        state.stats = {};
        practice.showBest();
        await this.load();
        toast.show("History cleared.");
        $("#progressTitle").focus();
      } catch (e) {
        $("#progressEmpty").hidden = false;
        $("#progressEmpty").querySelector("h2").textContent = "Couldn't clear your history";
        $("#progressEmpty").querySelector("p").textContent = e.message;
      }
    },
  };

  /* ---------- Forms (validation messages match the server's) ---------- */
  const forms = {
    bind(selector, onSubmit) {
      const form = $(selector);
      // Link each input to its hint and error text for screen readers.
      $$("input", form).forEach((input) => {
        const err = form.querySelector(`.field-error[data-for="${input.name}"]`);
        if (!err) return;
        err.id = `${input.id}-error`;
        const ids = (input.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
        input.setAttribute("aria-describedby", [...ids, err.id].join(" "));
      });
      form.addEventListener("input", (e) => {
        if (e.target.matches("input")) this.setFieldError(form, e.target.name, "");
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        this.clear(form);
        if (!this.validate(form)) return;
        const values = Object.fromEntries(new FormData(form));
        const btn = form.querySelector('button[type="submit"]');
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = btn.dataset.busy || label;
        try {
          await onSubmit(values, form);
        } catch (err) {
          this.showErrors(form, err);
        } finally {
          btn.disabled = false;
          btn.textContent = label;
        }
      });
    },

    validate(form) {
      let first = null;
      $$("input", form).forEach((input) => {
        const v = input.validity;
        let msg = "";
        if (v.valueMissing || (input.required && !input.value.trim())) msg = input.dataset.missing || "Fill in this field.";
        else if (v.typeMismatch || v.patternMismatch) msg = input.dataset.invalid || "Check this value.";
        else if (input.minLength > 0 && input.value.length < input.minLength) msg = input.dataset.short || `Use at least ${input.minLength} characters.`;
        if (msg) {
          this.setFieldError(form, input.name, msg);
          first = first || input;
        }
      });
      if (first) first.focus();
      return !first;
    },

    setFieldError(form, name, message) {
      const input = form.querySelector(`[name="${name}"]`);
      const err = form.querySelector(`.field-error[data-for="${name}"]`);
      if (err) err.textContent = message;
      if (input) {
        if (message) input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
    },

    showErrors(form, err) {
      const fields = err.fields || {};
      const names = Object.keys(fields);
      names.forEach((name) => this.setFieldError(form, name, fields[name]));
      // Field messages explain the problem where it happened; otherwise show the general one.
      form.querySelector(".form-error").textContent = names.length ? "" : err.message;
      const firstInput = names.length && form.querySelector(`[name="${names[0]}"]`);
      if (firstInput) firstInput.focus();
    },

    clear(form) {
      $$(".field-error, .form-error", form).forEach((el) => { el.textContent = ""; });
      $$("[aria-invalid]", form).forEach((el) => el.removeAttribute("aria-invalid"));
    },

    reset(form) {
      if (!form) return;
      this.clear(form);
      $$('input[type="password"], input[data-revealed]', form).forEach((input) => { input.value = ""; });
      $$(".reveal", form).forEach((b) => setReveal(b, false));
    },
  };

  function setReveal(button, show) {
    const input = button.parentElement.querySelector("input");
    input.type = show ? "text" : "password";
    if (show) input.dataset.revealed = "1"; else delete input.dataset.revealed;
    button.textContent = show ? "Hide" : "Show";
    button.setAttribute("aria-pressed", String(show));
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".reveal");
    if (b) setReveal(b, b.getAttribute("aria-pressed") !== "true");
  });

  /* Refresh per-user data after logging in or out. */
  async function refreshStats() {
    try {
      state.stats = (await api("/history?limit=1")).by_question || {};
    } catch {
      state.stats = {};
    }
    practice.showBest();
    if (router.view === "bank") bank.renderList();
  }

  /* ---------- Accounts ---------- */
  const auth = {
    user: null,
    returnTo: "practice",

    async load() {
      try {
        this.user = (await api("/auth/me")).user;
      } catch {
        this.user = null;
      }
      this.render();
    },

    render() {
      const user = this.user;
      $$("[data-guest]").forEach((el) => { el.hidden = Boolean(user); });
      $$("[data-user]").forEach((el) => { el.hidden = !user; });
      if (user) {
        $("#avatar").textContent = (user.name.trim()[0] || "?").toUpperCase();
        $("#accountName").textContent = this.firstName();
        $(".account-link").setAttribute("aria-label", `Account: ${user.name}`);
      }
    },

    firstName() { return this.user ? this.user.name.trim().split(/\s+/)[0] : ""; },

    async signedIn(user, message) {
      this.user = user;
      this.render();
      await refreshStats();
      toast.show(message);
      const target = ["practice", "bank", "progress", "account"].includes(this.returnTo) ? this.returnTo : "practice";
      this.returnTo = "practice";
      location.hash = `#/${target}`;
    },

    async signedOut(message) {
      this.user = null;
      this.render();
      await refreshStats();
      practice.show(); // clear any answer still on screen
      toast.show(message);
      location.hash = "#/practice";
    },

    init() {
      forms.bind("#loginForm", async (values) => {
        const { user } = await api("/auth/login", jsonBody("POST", values));
        await this.signedIn(user, `Logged in as ${user.email}.`);
      });
      forms.bind("#registerForm", async (values) => {
        const { user } = await api("/auth/register", jsonBody("POST", values));
        await this.signedIn(user, `Account created. Welcome, ${user.name.trim().split(/\s+/)[0]}.`);
      });
      const logoutBtn = $("#logoutBtn");
      logoutBtn.addEventListener("click", async () => {
        logoutBtn.disabled = true;
        try {
          // Let in-flight requests finish first, so none of them can restore the session afterwards.
          await Promise.allSettled([...pending]);
          try { await api("/auth/logout", { method: "POST" }); } catch { /* the session ends either way */ }
          await this.signedOut("Logged out.");
        } finally {
          logoutBtn.disabled = false;
        }
      });
    },
  };

  const account = {
    init() {
      forms.bind("#passwordForm", async (values, form) => {
        await api("/auth/password", jsonBody("POST", values));
        forms.reset(form);
        toast.show("Password updated.");
      });
      const dialog = $("#deleteDialog");
      $("#deleteAccountBtn").addEventListener("click", () => {
        forms.reset($("#deleteForm"));
        dialog.showModal();
      });
      $("[data-close]", dialog).addEventListener("click", () => dialog.close());
      forms.bind("#deleteForm", async (values) => {
        await api("/auth/account", jsonBody("DELETE", values));
        dialog.close();
        await auth.signedOut("Account deleted.");
      });
    },

    async render() {
      const u = auth.user;
      if (!u) return;
      $("#accountSub").textContent = `Signed in as ${u.email}`;
      forms.reset($("#passwordForm"));
      let attempts = "–";
      try { attempts = (await api("/history?limit=1")).averages.n; } catch { /* keep the dash */ }
      const since = new Date(u.created);
      $("#profile").innerHTML = [
        ["Name", esc(u.name)],
        ["Email", esc(u.email)],
        ["Member since", isNaN(since) ? "" : esc(since.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }))],
        ["Attempts saved", attempts],
      ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    },
  };

  /* ---------- Start ---------- */
  async function init() {
    theme.init();
    recorder.init();
    progress.init();
    auth.init();
    account.init();
    try {
      const [qs, hist] = await Promise.all([
        api("/questions"),
        api("/history?limit=1").catch(() => null),
        auth.load(),
      ]);
      state.questions = qs.questions;
      state.groups = qs.groups && qs.groups.length ? qs.groups : [{ label: "Topics", categories: qs.categories }];
      state.difficulties = qs.difficulties || state.difficulties;
      state.questions.forEach((q) => state.byId.set(q.id, q));
      if (hist) state.stats = hist.by_question || {};
    } catch (e) {
      $("#qTags").innerHTML = "";
      $("#qText").textContent = "Couldn't load questions.";
      $("#qBest").textContent = `${e.message}`;
      $$("#view-practice button, #view-practice select, #view-practice textarea").forEach((el) => { el.disabled = true; });
      router.init();
      return;
    }
    practice.init();
    bank.init();
    router.init();
  }

  init();
})();
