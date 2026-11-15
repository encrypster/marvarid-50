// AI tahlil: har bir savol uchun langar so'zlar (k) va eslab qolish ilmog'i (m).
// Kalit faqat Worker sirlarida turadi (ANTHROPIC_API_KEY); kirish ACCESS_CODE bilan cheklangan.
import Anthropic from "@anthropic-ai/sdk";
import ASSETS from "./assets.gen.js";

const MAX_QUESTIONS = 25;      // bitta so'rovdagi savollar soni
const MAX_CHARS = 30000;       // bitta so'rovdagi matn hajmi

const SYSTEM = `You write memory aids for students cramming a multiple-choice test. The exact questions will appear in the real exam, so the goal is pure memorisation of "this question -> this answer", with emphasis on visual memory.

You receive a JSON array of {id, q, ok, bad}: the question, the correct answers per the official key, and the wrong options. Many questions are near-duplicates that differ by one word, so the aids must help tell them apart.

For every question return:
- "k": 1-2 anchor strings copied EXACTLY (character for character, same apostrophes and case) from that question's "q". Each is one word or a short two-word phrase that best distinguishes this question from the similar ones. Never generic filler words. If the question is negative ("xos emas", "kirmaydi", "except", "not"), the negation must be one of the anchors.
- "m": one short memory hook (at most about 110 characters) in the SAME language and script as the question, in natural student language. It ties the anchor to the correct answer(s) through a vivid picture, a sound or letter similarity, a first-letter acronym for multi-answer questions, or a contrast with a look-alike question. It must name or clearly point at the correct answer(s).

The official key in "ok" is the truth for this task even if it looks wrong or two look-alike questions contradict each other: never correct it, never hint it may be wrong, and add no factual claims beyond linking question and answer. Return every id exactly once.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          k: { type: "array", items: { type: "string" } },
          m: { type: "string" },
        },
        required: ["id", "k", "m"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function sameCode(a, b) {            // vaqt bo'yicha farq bermaydigan solishtirish
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---- umumiy: kirish, Claude chaqiruvi ----
class ApiError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }

async function readBody(request, env) {
  if (!env.ANTHROPIC_API_KEY || !env.ACCESS_CODE) throw new ApiError("not_configured", 503);
  if (!sameCode(request.headers.get("x-access-code") || "", env.ACCESS_CODE)) throw new ApiError("bad_code", 401);
  try { return await request.json(); } catch { throw new ApiError("bad_json", 400); }
}

// Savollar ro'yxatini tekshiradi; javob kaliti (ok/bad) o'zgartirilmaydi, faqat uzatiladi.
function cleanQuestions(list, max, maxChars, key) {
  if (!Array.isArray(list) || !list.length || list.length > max) throw new ApiError("bad_request", 400);
  const out = [];
  for (const q of list) {
    const id = key === "n" ? q?.n : q?.id;
    if ((key === "n" ? !Number.isInteger(id) : typeof id !== "string") || typeof q?.q !== "string" || !Array.isArray(q.ok)) throw new ApiError("bad_request", 400);
    const item = { [key]: key === "n" ? id : id.slice(0, 40), q: q.q, ok: q.ok.map(String) };
    if (Array.isArray(q.bad)) item.bad = q.bad.map(String);
    out.push(item);
  }
  const payload = JSON.stringify(out);
  if (payload.length > maxChars) throw new ApiError("too_large", 413);
  return { list: out, payload };
}

async function ask(env, { system, payload, schema, maxTokens = 16000 }) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages
      .stream({
        model: "claude-opus-5-5",
        max_tokens: maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",          // xavfsizlik filtri rad etsa, so'rov zaxira modelda qayta bajariladi
        system,
        messages: [{ role: "user", content: payload }],
        output_config: { format: { type: "json_schema", schema } },
      })
      .finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new ApiError("rate_limited", 429);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new ApiError("ai_auth", 502);
    if (e instanceof Anthropic.APIError) { console.error("ai_error", e.status, e.message); throw new ApiError("ai_error", 502); }
    throw new ApiError("ai_unreachable", 502);
  }
  if (response.stop_reason === "refusal") throw new ApiError("refused", 422);
  if (response.stop_reason === "max_tokens") throw new ApiError("too_long", 502);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch { throw new ApiError("bad_ai_output", 502); }
}

const fail = (e) => (e instanceof ApiError ? json({ error: e.code }, e.status) : json({ error: "server_error" }, 500));

// Uzoq so'rovlar: javob tayyor bo'lguncha bo'sh joy yuborib turiladi (ulanish uzilmasligi uchun), oxirida JSON.
function slow(work) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const beat = setInterval(() => w.write(enc.encode(" ")).catch(() => {}), 8000);
  (async () => {
    let out;
    try { out = await work(); } catch (e) { out = { error: e instanceof ApiError ? e.code : "server_error" }; }
    clearInterval(beat);
    try { await w.write(enc.encode(JSON.stringify(out))); await w.close(); } catch {}
  })();
  return new Response(readable, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: "array", items });
const KEY_RULE = `The official key in "ok" is what the exam will mark as correct. Never change it, never present a different answer as correct.`;
const LANG_RULE = `Write all text in the same language and script as the questions.`;

// ---- 1. langar so'zlar va ilmoqlar ----
async function analyze(request, env) {
  const body = await readBody(request, env);
  const { list, payload } = cleanQuestions(body?.questions, MAX_QUESTIONS, MAX_CHARS, "id");
  const data = await ask(env, { system: SYSTEM, payload, schema: SCHEMA });
  const byId = Object.fromEntries(list.map((q) => [q.id, q]));
  const out = {};
  for (const it of data.items || []) {
    const q = byId[it.id];
    if (!q || typeof it.m !== "string") continue;
    out[it.id] = { k: (it.k || []).filter((k) => typeof k === "string" && k && q.q.includes(k)).slice(0, 2), m: it.m.trim().slice(0, 200) };
  }
  return json({ items: out });
}

// ---- 2. butun test bo'yicha: mavzular, o'xshash juftliklar, kalit tekshiruvi ----
const DECK_TASKS = {
  topics: {
    system: `You organise a multiple-choice test bank into study topics. Input: a JSON array of {n, q, ok}. Group the questions into 5-14 topics by subject matter (for a medical bank: one disease or syndrome per topic). Every n must appear in exactly one topic. Topic names are short (1-4 words). Order topics as they first appear in the bank. ${LANG_RULE}`,
    schema: obj({ topics: arr(obj({ name: { type: "string" }, nos: arr({ type: "integer" }) })) }),
  },
  pairs: {
    system: `You help students who confuse look-alike questions in a multiple-choice test bank. Input: a JSON array of {n, q, ok, bad}. Find the pairs of questions that are most likely to be confused with each other: same or nearly the same wording with different correct answers, or questions that differ by one word (a stage, a number, a negation, a drug, a disease). Return up to 80 pairs, most confusable first; a question may appear in several pairs. For each pair write "d": one short sentence (max ~140 characters) that states the wording difference and which answer goes with which, quoting the answers exactly as given in "ok". ${KEY_RULE} ${LANG_RULE}`,
    schema: obj({ pairs: arr(obj({ a: { type: "integer" }, b: { type: "integer" }, d: { type: "string" } })) }),
  },
  audit: {
    system: `You audit the answer key of a multiple-choice test bank before students memorise it. Input: a JSON array of {n, q, ok, bad} where "ok" are the options marked correct and "bad" the options marked wrong. Report only real problems a student should double-check against the source:
- "conflict": two questions with the same or equivalent wording whose keys contradict each other (set "o" to the other question's n).
- "suspect": the marked answer is very likely wrong on the facts, or a clearly correct option is marked wrong, or the question states a number of answers that differs from the number marked.
- "format": the text looks damaged in a way that changes the meaning (an option merged into the question, a truncated option, a negation that makes the key the opposite).
Be conservative: do not report style, spelling, or debatable points. For each issue write "note": one or two short sentences saying what looks wrong and what to check. Do not rewrite the key; you only point at it. Use "o": 0 when no second question is involved. ${LANG_RULE}`,
    schema: obj({ issues: arr(obj({ n: { type: "integer" }, o: { type: "integer" }, kind: { type: "string", enum: ["conflict", "suspect", "format"] }, note: { type: "string" } })) }),
  },
};

async function deck(request, env) {
  const body = await readBody(request, env);
  const task = DECK_TASKS[body?.task];
  if (!task) throw new ApiError("bad_request", 400);
  const { list, payload } = cleanQuestions(body.questions, 1200, 600000, "n");
  const nos = new Set(list.map((q) => q.n));
  return slow(async () => {
    const data = await ask(env, { system: task.system, payload, schema: task.schema, maxTokens: 32000 });
    if (body.task === "topics") {
      const seen = new Set();
      return { topics: (data.topics || []).map((t) => ({ name: String(t.name).slice(0, 60), nos: (t.nos || []).filter((n) => nos.has(n) && !seen.has(n) && seen.add(n)) })).filter((t) => t.nos.length) };
    }
    if (body.task === "pairs") return { pairs: (data.pairs || []).filter((p) => nos.has(p.a) && nos.has(p.b) && p.a !== p.b).slice(0, 80).map((p) => ({ a: p.a, b: p.b, d: String(p.d).slice(0, 300) })) };
    return { issues: (data.issues || []).filter((i) => nos.has(i.n)).map((i) => ({ n: i.n, o: nos.has(i.o) ? i.o : 0, kind: i.kind, note: String(i.note).slice(0, 500) })) };
  });
}

// ---- 3. "Nega shu javob?" ----
async function explain(request, env) {
  const body = await readBody(request, env);
  const { payload } = cleanQuestions([{ id: "x", q: body?.q, ok: body?.ok, bad: body?.bad }], 1, 6000, "id");
  const data = await ask(env, {
    system: `A student got this multiple-choice question wrong while cramming for an exam. Input: {q, ok, bad}. In 2-3 short sentences explain why the answer(s) in "ok" are the right ones and what separates them from the most tempting wrong option, so the answer sticks. Plain student language, no preamble. ${KEY_RULE} If you are confident the key itself is factually wrong, still explain the key as given, and set "doubt" to true; otherwise false. ${LANG_RULE}`,
    payload,
    schema: obj({ text: { type: "string" }, doubt: { type: "boolean" } }),
    maxTokens: 4000,
  });
  return json({ text: String(data.text || "").slice(0, 900), doubt: data.doubt === true });
}

// ---- 4. shaxsiy shpargalka: AI faqat guruhlaydi va savolni qisqartiradi; javoblar ilovada fayldan olinadi ----
async function sheet(request, env) {
  const body = await readBody(request, env);
  const { list, payload } = cleanQuestions(body?.questions, 60, 60000, "n");
  const nos = new Set(list.map((q) => q.n));
  const data = await ask(env, {
    system: `You lay out a one-page cheat sheet from the questions a student keeps getting wrong. Input: a JSON array of {n, q, ok}. Group them into 2-8 sections by subject and, for each question, write "cue": the question compressed to its distinguishing core in at most 8 words (keep negations such as "xos emas"). Do not write the answers - the app prints them from the key. Every n appears exactly once. ${LANG_RULE}`,
    payload,
    schema: obj({ sections: arr(obj({ title: { type: "string" }, rows: arr(obj({ n: { type: "integer" }, cue: { type: "string" } })) })) }),
    maxTokens: 8000,
  });
  const seen = new Set();
  return json({ sections: (data.sections || []).map((s) => ({ title: String(s.title).slice(0, 60), rows: (s.rows || []).filter((r) => nos.has(r.n) && !seen.has(r.n) && seen.add(r.n)).map((r) => ({ n: r.n, cue: String(r.cue).slice(0, 120) })) })).filter((s) => s.rows.length) });
}

const ROUTES = { "/api/analyze": analyze, "/api/deck": deck, "/api/explain": explain, "/api/sheet": sheet };

function asset(request, path) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const f = ASSETS[path === "/" ? "/index.html" : path];
  if (!f) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  const headers = { "content-type": f.type, etag: f.etag, "cache-control": path === "/version.json" ? "no-store" : "no-cache", "x-content-type-options": "nosniff" };
  if (request.headers.get("if-none-match") === f.etag) return new Response(null, { status: 304, headers });
  const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = ROUTES[url.pathname];
    if (route) {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      try { return await route(request, env); } catch (e) { return fail(e); }
    }
    if (url.pathname === "/api/ping") return json({ ok: true, ai: Boolean(env.ANTHROPIC_API_KEY && env.ACCESS_CODE) });
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return asset(request, url.pathname);
  },
};
