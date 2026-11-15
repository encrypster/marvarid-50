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

async function analyze(request, env) {
  if (!env.ANTHROPIC_API_KEY || !env.ACCESS_CODE) return json({ error: "not_configured" }, 503);
  if (!sameCode(request.headers.get("x-access-code") || "", env.ACCESS_CODE)) return json({ error: "bad_code" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const qs = Array.isArray(body?.questions) ? body.questions : null;
  if (!qs || !qs.length || qs.length > MAX_QUESTIONS) return json({ error: "bad_request" }, 400);
  const clean = [];
  for (const q of qs) {
    if (typeof q?.id !== "string" || typeof q?.q !== "string" || !Array.isArray(q.ok) || !Array.isArray(q.bad)) return json({ error: "bad_request" }, 400);
    clean.push({ id: q.id.slice(0, 40), q: q.q, ok: q.ok.map(String), bad: q.bad.map(String) });
  }
  const payload = JSON.stringify(clean);
  if (payload.length > MAX_CHARS) return json({ error: "too_large" }, 413);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",          // xavfsizlik filtri rad etsa, so'rov zaxira modelda qayta bajariladi
      system: SYSTEM,
      messages: [{ role: "user", content: payload }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return json({ error: "ai_auth" }, 502);
    if (e instanceof Anthropic.APIError) return json({ error: "ai_error", status: e.status, message: String(e.message).slice(0, 300) }, 502);
    return json({ error: "ai_unreachable" }, 502);
  }
  if (response.stop_reason === "refusal") return json({ error: "refused" }, 422);
  if (response.stop_reason === "max_tokens") return json({ error: "too_long" }, 502);

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let items;
  try { items = JSON.parse(text).items; } catch { return json({ error: "bad_ai_output" }, 502); }
  const byId = Object.fromEntries(clean.map((q) => [q.id, q]));
  const out = {};
  for (const it of items || []) {
    const q = byId[it.id];
    if (!q || typeof it.m !== "string") continue;
    out[it.id] = { k: (it.k || []).filter((k) => typeof k === "string" && k && q.q.includes(k)).slice(0, 2), m: it.m.trim().slice(0, 200) };
  }
  return json({ items: out, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } });
}

function asset(request, path) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const f = ASSETS[path === "/" ? "/index.html" : path];
  if (!f) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  const headers = { "content-type": f.type, etag: f.etag, "cache-control": "no-cache", "x-content-type-options": "nosniff" };
  if (request.headers.get("if-none-match") === f.etag) return new Response(null, { status: 304, headers });
  const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/analyze") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      return analyze(request, env);
    }
    if (url.pathname === "/api/ping") return json({ ok: true, ai: Boolean(env.ANTHROPIC_API_KEY && env.ACCESS_CODE) });
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return asset(request, url.pathname);
  },
};
