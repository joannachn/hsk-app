"use strict";

// ---------- Wortliste ----------
// Zeilen aus data/hsk30.js: [Zeichen, Pinyin, Englisch, Stufe, Rang, Wortverbindungen?, Satz?, Satz-Pinyin?, Satz-Englisch?]
const WORDS = (window.HSK_WORDS || []).map((r) => ({
  k: r[0] + "|" + r[1], h: r[0], py: r[1], en: r[2], lv: r[3],
  coll: r[5] ? r[5].split(" · ") : [],
  ex: r[6] ? { zh: r[6], py: r[7], tr: r[8] } : null,
}));
const BY_KEY = new Map(WORDS.map((w) => [w.k, w]));
const LEVELS = [1, 2, 3, 4, 5, 6, 7];
const levelName = (lv) => (lv === 7 ? "HSK 7–9" : "HSK " + lv);

// ---------- Zeit ----------
// Ein Lerntag beginnt um 4 Uhr morgens, damit spätabendliches Lernen noch zum Vortag zählt.
function dayNum(ts = Date.now()) {
  const d = new Date(ts - 4 * 3600e3);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60e3) / 86400e3);
}
function dayKey(n) { return new Date(n * 86400e3).toISOString().slice(0, 10); }

// ---------- Zustand ----------
const DEFAULT_SETTINGS = { levels: [1], newPerDay: 10, dir: "r", tones: true, pinyinFront: false, order: "freq" };
const S = {
  settings: { ...DEFAULT_SETTINGS },
  cards: {},   // "<wortKey>#r" | "<wortKey>#p" -> {due, ivl, ease, reps, lapses, l?, t}
  notes: {},   // wortKey -> {n, mean, ex:{zh,py,tr}, gen:{coll,zh,py,tr}, skip, t}
  log: {},     // "YYYY-MM-DD" -> {rev, neu}
};

const SHARDS = 32;
function shardOf(wordKey) {
  let h = 0;
  for (const ch of wordKey) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return "s" + String(h % SHARDS).padStart(2, "0");
}
const wordOfCard = (ck) => ck.slice(0, ck.lastIndexOf("#"));

// ---------- Speicher: localStorage (sofort) + db (geräteübergreifend) ----------
const LS_KEY = "zibiao-v1";
function lsLoad() {
  try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function lsSave() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch { /* privates Fenster o. Ä. */ }
}
function mergeMap(into, from) {
  for (const [k, v] of Object.entries(from || {})) {
    if (!into[k] || (v && (v.t || 0) > (into[k].t || 0))) into[k] = v;
  }
}
function applySnapshot(snap) {
  if (!snap) return;
  if (snap.settings && (snap.settings.t || 0) >= (S.settings.t || 0)) S.settings = { ...DEFAULT_SETTINGS, ...snap.settings };
  mergeMap(S.cards, snap.cards);
  mergeMap(S.notes, snap.notes);
  for (const [d, v] of Object.entries(snap.log || {})) {
    const cur = S.log[d] || { rev: 0, neu: 0 };
    S.log[d] = { rev: Math.max(cur.rev, v.rev || 0), neu: Math.max(cur.neu, v.neu || 0) };
  }
}

const cloud = { db: null, uid: null, dirty: new Set(), timer: null, busy: false };

async function connectCloud() {
  if (!window.claude || !window.claude.use) return;
  try {
    const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
    if (!db || !user) return;
    const uid = await user.id();
    if (!uid) return;
    const col = db.collection("data/users/" + uid);
    const snap = await col.get();
    const remote = { cards: {}, notes: {}, log: {} };
    for (const d of snap.docs) {
      const body = d.data() || {};
      if (d.id === "settings") remote.settings = body;
      else if (d.id === "log") remote.log = body.days || {};
      else { Object.assign(remote.cards, body.c || {}); Object.assign(remote.notes, body.n || {}); }
    }
    cloud.db = db; cloud.uid = uid;
    applySnapshot(remote);
    lsSave();
    // Was nur lokal lag (z. B. vor der ersten Verbindung gelernt), einmal hochladen.
    const local = new Set([...Object.keys(S.cards).map((k) => shardOf(wordOfCard(k))), ...Object.keys(S.notes).map(shardOf)]);
    for (const id of local) if (!snap.docs.some((d) => d.id === id)) cloud.dirty.add(id);
    if (snap.docs.length === 0 && (Object.keys(S.log).length || S.settings.t)) { cloud.dirty.add("settings"); cloud.dirty.add("log"); }
    setSync("ok", "Synchronisiert");
    flushSoon();
    render();
  } catch (e) {
    setSync("", "Nur dieses Gerät");
  }
}

function shardBody(id) {
  const c = {}, n = {};
  for (const [k, v] of Object.entries(S.cards)) if (shardOf(wordOfCard(k)) === id) c[k] = v;
  for (const [k, v] of Object.entries(S.notes)) if (shardOf(k) === id) n[k] = v;
  return { c, n };
}
function markDirty(...ids) {
  lsSave();
  ids.forEach((id) => cloud.dirty.add(id));
  flushSoon();
}
function flushSoon() {
  if (!cloud.db) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(flush, 1500);
}
async function flush() {
  if (!cloud.db || cloud.busy) return;
  cloud.busy = true;
  const col = cloud.db.collection("data/users/" + cloud.uid);
  try {
    while (cloud.dirty.size) {
      const id = cloud.dirty.values().next().value;
      cloud.dirty.delete(id);
      const body = id === "settings" ? S.settings : id === "log" ? { days: S.log } : shardBody(id);
      await col.doc(id).set(body);
    }
    setSync("ok", "Synchronisiert");
  } catch (e) {
    setSync("", e && e.code === "quota_exceeded" ? "Speicher voll" : "Sync pausiert");
  } finally {
    cloud.busy = false;
    if (cloud.dirty.size) flushSoon();
  }
}
function setSync(cls, text) {
  const el = document.getElementById("sync");
  el.className = "sync " + cls;
  el.querySelector("span").textContent = text;
}

// ---------- Wiederholungsplanung (vereinfachtes SM-2) ----------
function newCard() { return { due: dayNum(), ivl: 0, ease: 2.5, reps: 0, lapses: 0, l: 0, t: Date.now() }; }

function preview(c, r) {
  // gibt {ivl, ease, l} zurück; l gesetzt = bleibt in der heutigen Runde
  let { ivl, ease } = c;
  if (c.l !== undefined) {
    if (r === 1) return { ivl: 0, ease, l: 0, again: 2 };
    if (r === 2) return { ivl: 0, ease, l: 1, again: 5 };
    if (r === 3) return { ivl: c.lapses ? Math.max(1, Math.round(c.ivl * 0.5)) : 1, ease };
    return { ivl: c.lapses ? Math.max(2, c.ivl) : 4, ease: ease + 0.15 };
  }
  if (r === 1) return { ivl: 1, ease: Math.max(1.3, ease - 0.2), l: 0, again: 3, lapse: true };
  if (r === 2) return { ivl: Math.max(ivl + 1, Math.round(ivl * 1.2)), ease: Math.max(1.3, ease - 0.15) };
  if (r === 3) return { ivl: Math.max(ivl + 1, Math.round(ivl * ease)), ease };
  return { ivl: Math.max(ivl + 2, Math.round(ivl * ease * 1.3)), ease: ease + 0.15 };
}
function intervalLabel(c, r) {
  const p = preview(c, r);
  if (p.l !== undefined) return r === 1 ? "gleich" : "später";
  const d = p.ivl;
  if (d < 30) return d + (d === 1 ? " Tag" : " Tage");
  if (d < 365) return Math.round(d / 30) + " Mon.";
  return (d / 365).toFixed(1).replace(".", ",") + " J.";
}
function applyRating(c, r) {
  const p = preview(c, r);
  const today = dayNum();
  c.ease = Math.round(p.ease * 100) / 100;
  c.t = Date.now();
  if (p.lapse) c.lapses++;
  if (p.l !== undefined) { c.l = p.l; c.due = today; return p.again; }
  delete c.l;
  c.reps++;
  // etwas Streuung, damit nicht alle Wörter eines Tages wieder gemeinsam fällig werden
  const fuzz = p.ivl > 4 ? Math.round((Math.random() - 0.5) * p.ivl * 0.1) : 0;
  c.ivl = p.ivl + fuzz;
  c.due = today + c.ivl;
  return 0;
}

// ---------- Wortstatus ----------
function dirs() { return S.settings.dir === "both" ? ["r", "p"] : [S.settings.dir]; }
function status(w) {
  const n = S.notes[w.k];
  if (n && n.skip) return "bekannt";
  const cs = ["r", "p"].map((d) => S.cards[w.k + "#" + d]).filter(Boolean);
  if (!cs.length) return "neu";
  return cs.every((c) => c.l === undefined && c.ivl >= 21) ? "fest" : "lernend";
}
const STATUS_LABEL = { neu: "Neu", lernend: "Lernend", fest: "Gefestigt", bekannt: "Kenne ich" };

function activeWords() {
  const lv = new Set(S.settings.levels);
  return WORDS.filter((w) => lv.has(w.lv));
}
function newToday() { return (S.log[dayKey(dayNum())] || {}).neu || 0; }
function bump(field) {
  const k = dayKey(dayNum());
  const e = S.log[k] || { rev: 0, neu: 0 };
  e[field]++;
  S.log[k] = e;
}
function dueCards() {
  const today = dayNum();
  const want = new Set(dirs());
  return Object.entries(S.cards)
    .filter(([k, c]) => c.due <= today && want.has(k.slice(-1)) && BY_KEY.has(wordOfCard(k)) && !(S.notes[wordOfCard(k)] || {}).skip)
    .sort((a, b) => a[1].due - b[1].due)
    .map(([k]) => k);
}
// Karten, die für die eingestellte Richtung noch fehlen (z. B. auch nach einem Richtungswechsel)
function nextNewCards(n) {
  if (n <= 0) return [];
  const out = [];
  for (const w of activeWords()) {
    if ((S.notes[w.k] || {}).skip) continue;
    const d = dirs().find((d) => !S.cards[w.k + "#" + d] && !(session && session.queue.includes(w.k + "#" + d)));
    if (!d) continue;
    out.push(w.k + "#" + d);
    if (out.length >= n) break;
  }
  return out;
}

// ---------- Lernrunde ----------
let session = null; // {queue:[cardKey], done, total, flipped, fresh:Set}

function startSession() {
  const due = dueCards();
  const freshKeys = nextNewCards(Math.max(0, S.settings.newPerDay - newToday()));
  // neue Karten zwischen die Wiederholungen mischen: nach jeweils 3 Wiederholungen eine neue
  const queue = [];
  let i = 0, j = 0;
  while (i < due.length || j < freshKeys.length) {
    for (let n = 0; n < 3 && i < due.length; n++) queue.push(due[i++]);
    if (j < freshKeys.length) queue.push(freshKeys[j++]);
  }
  session = { queue, done: 0, total: queue.length, flipped: false, fresh: new Set(freshKeys) };
  render();
}

function rate(r) {
  const ck = session.queue.shift();
  const wk = wordOfCard(ck);
  let c = S.cards[ck];
  const shards = new Set([shardOf(wk)]);
  if (!c) {
    c = S.cards[ck] = newCard();
    bump("neu");
    // Bei "beide Richtungen" kommt die Gegenrichtung erst morgen dran.
    if (S.settings.dir === "both") {
      const other = wk + "#" + (ck.endsWith("#r") ? "p" : "r");
      if (!S.cards[other]) { S.cards[other] = newCard(); S.cards[other].due = dayNum() + 1; }
    }
  } else if (!session.fresh.has(ck) && c.l === undefined) {
    bump("rev");
  }
  session.fresh.delete(ck);
  const again = applyRating(c, r);
  if (again) session.queue.splice(Math.min(again, session.queue.length), 0, ck);
  else session.done++;
  session.flipped = false;
  markDirty(...shards, "log");
  render();
}

// "Kenne ich schon": Wort aus allen Abfragen nehmen. Ein neues Wort zählt nicht als gelernt,
// deshalb rückt das nächste neue Wort nach, solange das Tageskontingent reicht.
function markKnown() {
  const ck = session.queue[0];
  const wk = wordOfCard(ck);
  const wasNew = session.fresh.has(ck);
  const n = S.notes[wk] || {};
  n.skip = true; n.t = Date.now(); S.notes[wk] = n;
  session.queue = session.queue.filter((k) => wordOfCard(k) !== wk);
  session.done++;
  if (wasNew) {
    session.fresh.delete(ck);
    const next = nextNewCards(Math.max(0, S.settings.newPerDay - newToday()) - session.fresh.size)[0];
    if (next) { session.queue.push(next); session.fresh.add(next); session.total++; }
  }
  session.flipped = false;
  markDirty(shardOf(wk));
  toast(`${BY_KEY.get(wk).h} wird nicht mehr abgefragt`);
  render();
}

// ---------- Hilfsfunktionen für die Darstellung ----------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TONE = { 1: "āēīōūǖĀĒĪŌŪǕ", 2: "áéíóúǘÁÉÍÓÚǗ", 3: "ǎěǐǒǔǚǍĚǏǑǓǙ", 4: "àèìòùǜÀÈÌÒÙǛ" };
function toneOf(syl) {
  for (const t of [1, 2, 3, 4]) if ([...syl].some((ch) => TONE[t].includes(ch))) return t;
  return 5;
}
function pyHtml(py) {
  return '<span class="py">' + py.split(/\s+/).map((s) => `<span class="s${toneOf(s)}">${esc(s)}</span>`).join("") + "</span>";
}
function meaning(w) {
  const n = S.notes[w.k] || {};
  return n.mean || w.en;
}
function collocations(w) {
  const n = S.notes[w.k] || {};
  return w.coll.length ? w.coll : (n.gen && n.gen.coll) || [];
}
function examples(w) {
  const n = S.notes[w.k] || {};
  const out = [];
  if (n.ex && n.ex.zh) out.push({ ...n.ex, own: true });
  if (w.ex) out.push(w.ex);
  else if (n.gen && n.gen.zh) out.push({ ...n.gen, gen: true });
  return out;
}
function exHtml(ex, w) {
  const zh = esc(ex.zh).split(esc(w.h)).join(`<mark>${esc(w.h)}</mark>`);
  return `<div class="ex">
    ${ex.own ? '<span class="lbl">Mein Satz</span>' : ex.gen ? '<span class="lbl">Von Claude ergänzt</span>' : ""}
    <div class="zh">${zh}</div>${ex.py ? `<div class="p">${esc(ex.py)}</div>` : ""}${ex.tr ? `<div class="d">${esc(ex.tr)}</div>` : ""}</div>`;
}
const SPEAK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN"; u.rate = 0.85;
    const v = speechSynthesis.getVoices().find((x) => /^zh(-|_)CN/i.test(x.lang));
    if (v) u.voice = v;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { toast("Sprachausgabe ist in diesem Browser nicht verfügbar."); }
}
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = msg; el.setAttribute("role", "status");
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// Kartenrückseite und Wortdetail teilen sich diesen Bereich; "afterMeaning" setzt die Lernrunde
// direkt unter die Bedeutung, damit die Bewertungsknöpfe ohne Scrollen erreichbar sind.
function detailHtml(w, afterMeaning = "") {
  const m = meaning(w);
  const coll = collocations(w);
  const exs = examples(w);
  const n = S.notes[w.k] || {};
  const needGen = !!window.claude && !w.ex && !(n.gen && n.gen.zh);
  return `
    <div class="row" style="justify-content:space-between">
      <div class="row">${pyHtml(w.py)}<button class="speak" data-speak="${esc(w.h)}" aria-label="Aussprache anhören">${SPEAK_SVG}</button></div>
      <span class="badge">${levelName(w.lv)}</span>
    </div>
    <div>
      <div class="mean">${esc(m)}</div>${n.mean ? `<div class="en">Wörterbuch: ${esc(w.en)}</div>` : ""}
    </div>
    ${afterMeaning}
    ${needGen ? `<div class="gen" data-gen-box="${esc(w.k)}"><button class="btn" data-gen="${esc(w.k)}">Beispielsatz ergänzen</button><span class="muted small">mit Claude</span></div>` : ""}
    ${coll.length ? `<div class="opt"><span class="lbl">Typische Verbindungen</span><div class="chips">${coll.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div></div>` : ""}
    ${exs.map((e) => exHtml(e, w)).join("")}
    <div class="opt">
      <label class="lbl" for="note">Meine Eselsbrücke</label>
      <textarea id="note" data-note="${esc(w.k)}" placeholder="z. B. 休 = Mensch 亻 lehnt am Baum 木 → ausruhen">${esc(n.n || "")}</textarea>
    </div>`;
}

// ---------- Ansichten ----------
const view = () => document.getElementById("view");
function currentRoute() {
  const h = location.hash.replace("#", "");
  return ["lernen", "woerter", "fortschritt", "optionen"].includes(h) ? h : "lernen";
}
function render() {
  const r = currentRoute();
  document.querySelectorAll("nav.tabs a").forEach((a) => {
    if (a.dataset.v === r) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.body.classList.toggle("notones", !S.settings.tones);
  ({ lernen: renderLearn, woerter: renderWords, fortschritt: renderProgress, optionen: renderOptions })[r]();
}

function renderLearn() {
  if (session && session.queue.length) return renderCard();
  if (session && !session.queue.length) {
    session = null;
    view().innerHTML = `<div class="empty"><div class="bighan">好</div><h2>Runde geschafft</h2><p class="muted">Für heute ist alles wiederholt. Morgen geht es weiter.</p></div>`;
    view().insertAdjacentHTML("beforeend", todayHtml());
    return;
  }
  view().innerHTML = todayHtml();
}
function todayHtml() {
  const due = dueCards().length;
  const freshLeft = nextNewCards(Math.max(0, S.settings.newPerDay - newToday())).length;
  const learned = activeWords().filter((w) => status(w) !== "neu").length;
  const total = activeWords().length;
  const lv = S.settings.levels.map(levelName).join(", ");
  return `
    <section class="opt"><h3>Heute</h3>
      <div class="today">
        <div class="stat"><div class="n">${due}</div><div class="l">fällig</div></div>
        <div class="stat"><div class="n">${freshLeft}</div><div class="l">neue Wörter</div></div>
        <div class="stat"><div class="n">${(S.log[dayKey(dayNum())] || {}).rev || 0}</div><div class="l">heute wiederholt</div></div>
      </div>
    </section>
    <button class="btn primary big" data-act="start" ${due + freshLeft ? "" : "disabled"}>${due + freshLeft ? "Lernrunde starten" : "Für heute fertig"}</button>
    ${HELP_HTML}
    <p class="muted small">${esc(lv)} · ${learned} von ${total} Wörtern begonnen · Richtung: ${{ r: "Chinesisch → Englisch", p: "Englisch → Chinesisch", both: "beide" }[S.settings.dir]}</p>`;
}

const HELP_HTML = `
  <details class="panel help">
    <summary><b>So funktioniert eine Lernrunde</b></summary>
    <p>Du siehst die Vorderseite und überlegst dir die Antwort, gern laut. Es gibt keinen Zeitdruck. Dann tippst du auf „Aufdecken“ und vergleichst. Danach sagst du ehrlich, wie es lief:</p>
    <dl>
      <dt class="r1">Nochmal</dt><dd>Gewusst hast du es nicht, oder falsch. Die Karte kommt in dieser Runde nach zwei, drei anderen Karten gleich noch einmal. Ein schon gelerntes Wort fängt dann wieder mit einem Tag Abstand an.</dd>
      <dt class="r2">Schwer</dt><dd>Richtig, aber nur mit Mühe. Der Abstand wächst nur wenig. Ein neues Wort kommt in dieser Runde später noch einmal.</dd>
      <dt class="r3">Gut</dt><dd>Richtig nach kurzem Nachdenken. Das ist der Normalfall. Der Abstand wird ungefähr 2,5-mal so lang: 1 Tag, 3 Tage, 8 Tage, 3 Wochen, 2 Monate …</dd>
      <dt class="r4">Leicht</dt><dd>Sofort und sicher gewusst. Der Abstand wächst noch stärker, und das Wort gilt künftig als leichter.</dd>
    </dl>
    <p class="muted small">Unter jedem Knopf steht, wann du das Wort wiedersiehst. Ab drei Wochen Abstand gilt ein Wort als gefestigt.</p>
  </details>`;

function renderCard() {
  const ck = session.queue[0];
  const w = BY_KEY.get(wordOfCard(ck));
  const dir = ck.slice(-1);
  const c = S.cards[ck] || newCard();
  const isNew = !S.cards[ck];
  const pct = session.total ? Math.round((session.done / session.total) * 100) : 0;
  const front = dir === "r"
    ? `<div class="bighan">${esc(w.h)}</div>${S.settings.pinyinFront ? pyHtml(w.py) : ""}${session.flipped ? "" : '<div class="ask">Was bedeutet das?</div>'}`
    : `<div class="prompt-de">${esc(meaning(w))}</div>${session.flipped ? "" : '<div class="ask">Wie heißt das auf Chinesisch?</div>'}`;
  const rateHtml = `<div class="rate">${[[1, "Nochmal"], [2, "Schwer"], [3, "Gut"], [4, "Leicht"]].map(([r, l]) => `<button class="r${r}" data-rate="${r}">${l}<small>${intervalLabel(c, r)}</small></button>`).join("")}</div>
    <button class="known" data-act="known">Kenne ich schon · nicht mehr abfragen</button>`;
  view().innerHTML = `
    <div class="progress" aria-label="Fortschritt der Runde"><i style="width:${pct}%"></i></div>
    <article class="card${session.flipped ? " flipped" : ""}" aria-live="polite">
      <div class="meta"><span>${isNew ? "NEUES WORT" : c.l !== undefined ? "WIRD GELERNT" : "WIEDERHOLUNG"}</span><span>noch ${session.queue.length}</span></div>
      <div class="front">${front}${dir === "p" && session.flipped ? `<div class="bighan">${esc(w.h)}</div>` : ""}</div>
      ${session.flipped
        ? `<div class="back">${detailHtml(w, rateHtml)}</div>`
        : `<button class="btn primary big" data-act="flip">Aufdecken</button>`}
    </article>
    <div class="row" style="justify-content:space-between"><button class="btn ghost small" data-act="stop">Runde beenden</button><span class="muted small">Tasten: Leertaste, 1–4</span></div>`;
}

let wordsState = { lv: 1, q: "", limit: 150 };
function renderWords() {
  const q = wordsState.q.trim().toLowerCase();
  const plainPy = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "").toLowerCase();
  let list = q
    ? WORDS.filter((w) => w.h.includes(q) || plainPy(w.py).includes(plainPy(q)) || meaning(w).toLowerCase().includes(q) || w.en.toLowerCase().includes(q))
    : WORDS.filter((w) => w.lv === wordsState.lv);
  const total = list.length;
  list = list.slice(0, wordsState.limit);
  view().innerHTML = `
    <div class="opt"><label class="lbl" for="search">Suchen</label>
      <input type="search" id="search" placeholder="Zeichen, Pinyin oder Englisch" value="${esc(wordsState.q)}"></div>
    ${q ? `<p class="muted small">${total} Treffer in allen Stufen</p>` : `<div class="levels" role="group" aria-label="Stufe">${LEVELS.map((l) => `<button data-lv="${l}" aria-pressed="${l === wordsState.lv}">${levelName(l)}</button>`).join("")}</div><p class="muted small">${total} Wörter, nach Häufigkeit sortiert</p>`}
    <ul class="words">${list.map((w) => {
      const st = status(w);
      return `<li><button data-word="${esc(w.k)}"><span class="w">${esc(w.h)}</span><span class="t"><div class="p">${esc(w.py)}</div><div>${esc(meaning(w) || w.en)}</div></span><span class="pill ${st}">${STATUS_LABEL[st]}</span></button></li>`;
    }).join("")}</ul>
    ${total > list.length ? `<button class="btn" data-act="more">${Math.min(150, total - list.length)} weitere anzeigen</button>` : ""}`;
}

function renderProgress() {
  const rows = LEVELS.map((lv) => {
    const ws = WORDS.filter((w) => w.lv === lv);
    let f = 0, l = 0;
    for (const w of ws) { const s = status(w); if (s === "fest" || s === "bekannt") f++; else if (s === "lernend") l++; }
    return { lv, n: ws.length, f, l };
  });
  const today = dayNum();
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = today - 13 + i; const e = S.log[dayKey(d)] || {};
    return { d, n: (e.rev || 0) + (e.neu || 0), neu: e.neu || 0 };
  });
  const max = Math.max(10, ...days.map((d) => d.n));
  const active = (d) => { const e = S.log[dayKey(d)]; return !!(e && (e.rev || e.neu)); };
  let streak = 0;
  for (let d = active(today) ? today : today - 1; active(d); d--) streak++;
  const totalStarted = WORDS.filter((w) => status(w) !== "neu").length;
  view().innerHTML = `
    <section class="today">
      <div class="stat"><div class="n">${streak}</div><div class="l">Tage in Folge</div></div>
      <div class="stat"><div class="n">${totalStarted}</div><div class="l">Wörter begonnen</div></div>
      <div class="stat"><div class="n">${Object.keys(S.cards).length}</div><div class="l">Karten</div></div>
    </section>
    <section class="panel"><h3>Karten pro Tag, letzte 14 Tage</h3>
      <div class="days" role="img" aria-label="Gelernte Karten pro Tag">${days.map((d) => `<div class="${d.n ? "" : "zero"}" style="height:${d.n ? Math.max(4, (d.n / max) * 100) : 2}%" title="${dayKey(d.d)}: ${d.n} Karten (${d.neu} neu)"></div>`).join("")}</div>
      <div class="dayl">${days.map((d) => `<span>${new Date(d.d * 86400e3).getUTCDate()}</span>`).join("")}</div>
    </section>
    <section class="panel"><h3>Stufen</h3>
      <div class="legend"><span><i style="background:var(--jade)"></i>Gefestigt (≥ 21 Tage) oder bekannt</span><span><i style="background:var(--jade-mid)"></i>Lernend</span><span><i style="background:var(--line)"></i>Neu</span></div>
      ${rows.map((r) => `<div class="lvl"><span>${levelName(r.lv)}</span>
        <div class="bar" title="${r.f} gefestigt, ${r.l} lernend, ${r.n - r.f - r.l} neu">${r.f ? `<i class="f" style="width:${(r.f / r.n) * 100}%"></i>` : ""}${r.l ? `<i class="l" style="width:${(r.l / r.n) * 100}%"></i>` : ""}</div>
        <span class="muted small" style="text-align:right;font-variant-numeric:tabular-nums">${r.f + r.l}/${r.n}</span></div>`).join("")}
    </section>`;
}

function renderOptions() {
  const s = S.settings;
  const radio = (name, val, label) => `<label><input type="radio" name="${name}" value="${val}" ${String(s[name]) === String(val) ? "checked" : ""}>${label}</label>`;
  view().innerHTML = `
    <section class="panel">
      <div class="opt"><span class="lbl">Stufen, aus denen neue Wörter kommen</span>
        <div class="seg">${LEVELS.map((l) => `<label><input type="checkbox" name="levels" value="${l}" ${s.levels.includes(l) ? "checked" : ""}>${levelName(l)}</label>`).join("")}</div>
        <p class="muted small">Wortverbindungen und Beispielsätze gibt es für HSK 1 bis 6. Für HSK 7–9 kannst du eigene Sätze eintragen${window.claude ? " oder sie pro Wort mit Claude ergänzen" : ""}.</p></div>
      <div class="opt"><label class="lbl" for="newPerDay">Neue Wörter pro Tag</label>
        <input type="number" id="newPerDay" min="0" max="100" value="${s.newPerDay}" style="max-width:120px"></div>
      <div class="opt"><span class="lbl">Abfragerichtung</span>
        <div class="seg">${radio("dir", "r", "汉 → Englisch")}${radio("dir", "p", "Englisch → 汉")}${radio("dir", "both", "Beide")}</div></div>
      <label class="check"><input type="checkbox" id="tones" ${s.tones ? "checked" : ""}> Pinyin nach Tönen einfärben</label>
      <label class="check"><input type="checkbox" id="pinyinFront" ${s.pinyinFront ? "checked" : ""}> Pinyin schon auf der Vorderseite zeigen</label>
    </section>
    <section class="panel"><h3>Sicherung</h3>
      <p class="small muted">${cloud.db ? "Dein Fortschritt wird in deinem Konto gespeichert und zwischen deinen Geräten abgeglichen." : "Dein Fortschritt liegt nur in diesem Browser. Lade ab und zu eine Sicherung herunter."}</p>
      <div class="row"><button class="btn" data-act="export">Sicherung herunterladen</button>
        <label class="btn" for="importFile">Sicherung einspielen</label><input type="file" id="importFile" accept="application/json,.json" hidden></div>
    </section>
    <p class="muted small">Wortliste: HSK 3.0 (2021) aus „complete-hsk-vocabulary“ (MIT), englische Bedeutungen aus CC-CEDICT (CC BY-SA). Wortverbindungen und Beispielsätze für HSK 1–6 von Claude verfasst.</p>`;
  markSegs();
}

// Markiert gewählte Optionen; ersetzt CSS :has(), das ältere Safari-Versionen nicht kennen.
function markSegs() {
  document.querySelectorAll(".seg label").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
}

// ---------- Wortdetail (Bottom Sheet) ----------
function openWord(k) {
  const w = BY_KEY.get(k);
  const n = S.notes[k] || {};
  const st = status(w);
  const layer = document.getElementById("layer");
  layer.innerHTML = `<div class="sheet-bg" data-act="close"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(w.h)}">
    <button class="btn ghost close" data-act="close">Schließen</button>
    <div class="bighan" style="text-align:center">${esc(w.h)}</div>
    ${detailHtml(w)}
    <div class="opt"><label class="lbl" for="ownMean">Eigene Bedeutung (ersetzt die Wörterbuch-Bedeutung)</label>
      <input type="text" id="ownMean" data-own="${esc(k)}" placeholder="z. B. kürzer, so wie du es dir merkst" value="${esc(n.mean || "")}"></div>
    <div class="opt"><span class="lbl">Eigener Beispielsatz</span>
      <input type="text" id="ownZh" data-own="${esc(k)}" placeholder="Chinesisch" value="${esc((n.ex || {}).zh || "")}">
      <div class="grid2"><input type="text" id="ownPy" data-own="${esc(k)}" placeholder="Pinyin (optional)" value="${esc((n.ex || {}).py || "")}">
      <input type="text" id="ownExTr" data-own="${esc(k)}" placeholder="Übersetzung" value="${esc((n.ex || {}).tr || "")}"></div></div>
    <div class="row"><span class="pill ${st}">${STATUS_LABEL[st]}</span>
      ${st === "neu" ? `<button class="btn primary" data-learn="${esc(k)}">Heute lernen</button>` : ""}
      <button class="btn" data-skip="${esc(k)}">${n.skip ? "Doch wieder abfragen" : "Kenne ich schon"}</button></div>
  </div></div>`;
}

// ---------- Ergänzen mit Claude ----------
let samplePromise = null;
function getSample() {
  if (!samplePromise) samplePromise = window.claude && window.claude.use ? window.claude.use("sample") : Promise.resolve(null);
  return samplePromise;
}
async function generate(k, btn) {
  const w = BY_KEY.get(k);
  const box = btn.closest("[data-gen-box]");
  const sample = await getSample();
  if (!sample) { box.innerHTML = '<span class="muted small">Ergänzen geht nur, wenn die App in Claude geöffnet ist. Du kannst unten einen eigenen Satz eintragen.</span>'; return; }
  btn.disabled = true; btn.textContent = "Claude schreibt …";
  const prompt = `You help a learner study Chinese vocabulary (${levelName(w.lv)}).
Word: ${w.h} (${w.py}); dictionary meaning: ${w.en}
Reply with only a JSON object of this shape:
{"coll": ["2 to 3 common, typical collocations in simplified Chinese that contain the word"],
 "zh": "one short, natural everyday sentence using the word, ideally with vocabulary up to this level",
 "py": "pinyin with tone marks for the sentence, words written together",
 "tr": "English translation of the sentence"}`;
  try {
    const g = await sample.json(prompt, { modelTier: "quick" });
    if (!g || typeof g.zh !== "string" || !g.zh) throw { code: "invalid_json" };
    const n = S.notes[k] || {};
    n.gen = { coll: Array.isArray(g.coll) ? g.coll.slice(0, 4).map(String) : [], zh: g.zh, py: String(g.py || ""), tr: String(g.tr || "") };
    n.t = Date.now();
    S.notes[k] = n;
    markDirty(shardOf(k));
    rerenderDetail(k);
  } catch (e) {
    btn.disabled = false; btn.textContent = "Nochmal versuchen";
    const msg = { not_granted: "Du hast Claude den Zugriff nicht erlaubt.", rate_limited: "Gerade zu viele Anfragen. Versuch es in einer Minute nochmal." }[e && e.code] || "Das hat nicht geklappt.";
    box.querySelector(".muted").textContent = msg;
  }
}
function rerenderDetail(k) {
  if (document.querySelector(".sheet")) openWord(k);
  if (session && currentRoute() === "lernen") renderCard();
}

// ---------- Ereignisse ----------
let noteTimer = null;
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-act],[data-rate],[data-lv],[data-word],[data-speak],[data-gen],[data-learn],[data-skip]");
  if (!t) return;
  const d = t.dataset;
  if (d.act === "close" && ev.target !== t) return; // Klick in das Sheet, nicht auf den Hintergrund
  if (d.act === "start") startSession();
  else if (d.act === "flip") { session.flipped = true; renderCard(); }
  else if (d.act === "stop") { session = null; render(); }
  else if (d.act === "known") markKnown();
  else if (d.act === "more") { wordsState.limit += 150; renderWords(); }
  else if (d.act === "close") { document.getElementById("layer").innerHTML = ""; if (currentRoute() === "woerter") renderWords(); }
  else if (d.act === "export") exportBackup();
  else if (d.rate) rate(+d.rate);
  else if (d.lv) { wordsState = { ...wordsState, lv: +d.lv, limit: 150 }; renderWords(); }
  else if (d.word) openWord(d.word);
  else if (d.speak) speak(d.speak);
  else if (d.gen) generate(d.gen, t);
  else if (d.learn) {
    const ck = d.learn + "#" + dirs()[0];
    if (!session) startSession();
    if (!session.queue.includes(ck)) { session.queue.unshift(ck); session.total++; session.fresh.add(ck); }
    document.getElementById("layer").innerHTML = "";
    location.hash = "#lernen"; render();
  } else if (d.skip) {
    const n = S.notes[d.skip] || {};
    n.skip = !n.skip; n.t = Date.now(); S.notes[d.skip] = n;
    markDirty(shardOf(d.skip)); openWord(d.skip);
  }
});

document.addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.id === "search") {
    wordsState.q = el.value; wordsState.limit = 150;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { renderWords(); const s = document.getElementById("search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 200);
    return;
  }
  const k = el.dataset.note || el.dataset.own;
  if (!k) return;
  const n = S.notes[k] || {};
  if (el.dataset.note) n.n = el.value;
  else if (el.id === "ownMean") n.mean = el.value.trim();
  else {
    n.ex = n.ex || {};
    n.ex[{ ownZh: "zh", ownPy: "py", ownExTr: "tr" }[el.id]] = el.value.trim();
  }
  n.t = Date.now();
  S.notes[k] = n;
  lsSave();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => markDirty(shardOf(k)), 800);
});

document.addEventListener("change", (ev) => {
  const el = ev.target;
  const s = S.settings;
  if (el.name === "levels") {
    s.levels = [...document.querySelectorAll('input[name="levels"]:checked')].map((x) => +x.value);
    if (!s.levels.length) { s.levels = [+el.value]; el.checked = true; }
  } else if (el.name === "dir") s.dir = el.value;
  else if (el.id === "newPerDay") s.newPerDay = Math.max(0, Math.min(100, Math.round(+el.value || 0)));
  else if (el.id === "tones") { s.tones = el.checked; document.body.classList.toggle("notones", !s.tones); }
  else if (el.id === "pinyinFront") s.pinyinFront = el.checked;
  else if (el.id === "importFile") return importBackup(el.files[0]);
  else return;
  markSegs();
  s.t = Date.now();
  session = null;
  markDirty("settings");
});

document.addEventListener("keydown", (ev) => {
  if (!session || currentRoute() !== "lernen" || /INPUT|TEXTAREA/.test(document.activeElement.tagName) || document.querySelector(".sheet")) return;
  if (!session.flipped && (ev.key === " " || ev.key === "Enter")) { ev.preventDefault(); session.flipped = true; renderCard(); }
  else if (session.flipped && ["1", "2", "3", "4"].includes(ev.key)) rate(+ev.key);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && document.querySelector(".sheet")) document.getElementById("layer").innerHTML = "";
});

window.addEventListener("hashchange", () => { document.getElementById("layer").innerHTML = ""; render(); });

// ---------- Sicherung ----------
async function exportBackup() {
  const data = JSON.stringify({ app: "zibiao", version: 1, exportedAt: new Date().toISOString(), ...S });
  const filename = `zibiao-sicherung-${dayKey(dayNum())}.json`;
  const dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
  if (dl) {
    try { await dl.save({ filename, data }); toast("Sicherung gespeichert"); } catch (e) { if (e && e.code !== "cancelled") toast("Speichern hat nicht geklappt."); }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = filename; a.click();
}
async function importBackup(file) {
  if (!file) return;
  try {
    const text = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsText(file); });
    const snap = JSON.parse(text);
    if (snap.app !== "zibiao") throw new Error();
    applySnapshot(snap);
    const ids = new Set(["settings", "log"]);
    Object.keys(snap.cards || {}).forEach((k) => ids.add(shardOf(wordOfCard(k))));
    Object.keys(snap.notes || {}).forEach((k) => ids.add(shardOf(k)));
    markDirty(...ids);
    toast("Sicherung eingespielt");
    render();
  } catch { toast("Diese Datei ist keine Zibiao-Sicherung."); }
}

// ---------- Start ----------
applySnapshot(lsLoad());
render();
connectCloud();
