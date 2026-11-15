import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import worker, {
  buildReport,
  parseAnalysis,
  quoteInText,
  redact,
  splitMessages,
  toPlain,
  webhookSecret,
} from "../src/index.js";

const SAMPLE = readFileSync(new URL("../../samples/namuna_shartnoma.txt", import.meta.url), "utf8");
const CHECKLIST = JSON.parse(readFileSync(new URL("../../data/checklist.json", import.meta.url), "utf8")).items;
const TOKEN = "123456:TEST-TOKEN";

function modelAnswer(overrides = {}) {
  const findings = CHECKLIST.map((item) => ({
    check_id: item.id,
    status: "joyida",
    quote: "",
    explanation: "Joyida.",
  }));
  findings[0] = {
    check_id: CHECKLIST[0].id,
    status: "muammo",
    quote: "taxminan 2027-yilning toʻrtinchi choragida foydalanishga",
    explanation: "Aniq sana yoʻq.",
  };
  findings[1] = {
    check_id: CHECKLIST[1].id,
    status: "muammo",
    quote: "Quruvchi hech qanday javobgar emas", // shartnomada yoʻq
    explanation: "Toʻqilgan iqtibos.",
  };
  findings.push({ check_id: "nomalum", status: "muammo", quote: "", explanation: "x" });
  return { is_housing_contract: true, summary: "Qisqa <xulosa>.", findings, other_risks: [], ...overrides };
}

/** Soxta muhit: AI, KV va Telegram oʻrniga xotiradagi nusxalar. */
function setup({ answer = modelAnswer(), aiError = null, fileText = SAMPLE } = {}) {
  const kv = new Map();
  const calls = { ai: [], telegram: [], converted: [] };
  const env = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    DAILY_LIMIT: "2",
    KV: {
      get: async (key) => kv.get(key) ?? null,
      put: async (key, value) => void kv.set(key, value),
    },
    AI: {
      run: async (model, input) => {
        calls.ai.push({ model, input });
        if (aiError) throw new Error(aiError);
        return { response: `<think>oʻylayapman {x}</think>\n${JSON.stringify(answer)}` };
      },
      toMarkdown: async (file) => {
        calls.converted.push(file.name);
        return { name: file.name, format: "text", data: fileText };
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/file/bot")) return new Response("fayl mazmuni");
    const method = target.split("/").pop();
    const body = JSON.parse(init.body);
    calls.telegram.push({ method, body });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: "docs/a.pdf" } });
    return Response.json({ ok: true });
  };
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const send = async (update, secret) => {
    const response = await worker.fetch(
      new Request("https://bot.example.workers.dev/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": secret ?? (await webhookSecret(TOKEN)) },
        body: JSON.stringify(update),
      }),
      env,
      ctx,
    );
    await Promise.all(pending);
    return response;
  };
  const sent = () => calls.telegram.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
  return { env, calls, send, sent, ctx };
}

const message = (extra, updateId = 1) => ({
  update_id: updateId,
  message: { chat: { id: 7 }, from: { id: 42 }, ...extra },
});

test("shaxsiy maʼlumot yashiriladi, narx va maydon saqlanadi", () => {
  const { text, hidden } = redact(SAMPLE);
  for (const secret of ["AB1234567", "12345678901234", "123 45 67"]) assert.ok(!text.includes(secret));
  assert.equal(hidden, 3);
  assert.ok(text.includes("717 600 000 soʻm") && text.includes("62,4 kv.m"));
  assert.equal(redact("Karta 8600 1234 5678 9012, h/r 20208000900123456001.").hidden, 2);
});

test("iqtibos boʻshliq va tutuq belgisi farqiga qaramay topiladi", () => {
  const text = "Quruvchi   narxni bir tomonlama\ntartibda qayta ko‘rib chiqishga haqli.";
  assert.ok(quoteInText("narxni bir tomonlama tartibda qayta koʻrib chiqishga haqli", text));
  assert.ok(!quoteInText("narxni xaridor roziligi bilan oʻzgartiradi", text));
  assert.ok(!quoteInText("", text));
});

test("model javobi tozalanadi va notoʻgʻri bandlar tashlanadi", () => {
  const parsed = parseAnalysis("Mana javob:\n```json\n" + JSON.stringify(modelAnswer()) + "\n```");
  assert.equal(parsed.findings.length, CHECKLIST.length);
  assert.ok(parsed.findings.every((f) => f.check_id !== "nomalum"));
  assert.throws(() => parseAnalysis("javob yoʻq"));
  assert.throws(() => parseAnalysis("{buzilgan json}"));
});

test("xabarlar Telegram chegarasiga sigʻadi", () => {
  const messages = splitMessages(["a".repeat(30), "b".repeat(30), Array(5).fill("c".repeat(20)).join("\n")], 50);
  assert.ok(messages.every((m) => m.length <= 50));
  assert.equal(messages.join("").split("c").length - 1, 100);
});

test("notoʻgʻri maxfiy sarlavha rad etiladi, / va /setup ishlaydi", async () => {
  const { env, calls, send, ctx } = setup();
  assert.equal((await send(message({ text: "/start" }), "notogri")).status, 401);
  assert.equal(calls.telegram.length, 0);

  const health = await worker.fetch(new Request("https://bot.example.workers.dev/"), env, ctx);
  assert.equal(await health.text(), "ok");

  await worker.fetch(new Request("https://bot.example.workers.dev/setup"), env, ctx);
  const hook = calls.telegram.at(-1);
  assert.equal(hook.method, "setWebhook");
  assert.equal(hook.body.url, "https://bot.example.workers.dev/webhook");
  assert.equal(hook.body.secret_token, await webhookSecret(TOKEN));
});

test("/start salomlashadi, takroriy yangilanish ikkinchi marta ishlanmaydi", async () => {
  const { send, sent } = setup();
  await send(message({ text: "/start" }));
  await send(message({ text: "/start" }));
  assert.equal(sent().length, 1);
  assert.ok(sent()[0].startsWith("Assalomu alaykum"));
});

test("matnli shartnoma: yashirilgan matn modelga ketadi, hisobot qaytadi", async () => {
  const { calls, send, sent } = setup();
  await send(message({ text: SAMPLE }));

  const prompt = calls.ai[0].input.messages[1].content;
  assert.ok(prompt.includes("[PASPORT]") && !prompt.includes("AB1234567"));
  assert.equal(calls.ai[0].model, "@cf/zai-org/glm-4.7-flash");
  assert.ok(calls.ai[0].input.messages[0].content.includes(CHECKLIST[0].id));

  const report = sent().slice(1).join("\n\n");
  assert.ok(sent()[0].startsWith("Tekshiryapman"));
  assert.ok(report.includes("Muammoli bandlar: 2 · Aniqlanmadi: 0"));
  assert.ok(report.includes("&lt;xulosa&gt;") && !report.includes("<xulosa>"));
  assert.equal(report.split("iqtibos matndan topilmadi").length - 1, 1);
  assert.ok(toPlain(report).includes(CHECKLIST[0].ask_developer));
  assert.ok(report.includes("3 ta shaxsiy maʼlumot yashirildi"));
  assert.ok(report.includes("huquqiy maslahat emas"));
});

test("PDF fayl Cloudflare orqali matnga aylantiriladi", async () => {
  const { calls, send, sent } = setup();
  await send(message({ document: { file_id: "f1", file_name: "Shartnoma.PDF", file_size: 1000 } }));
  assert.deepEqual(calls.converted, ["Shartnoma.PDF"]);
  assert.ok(sent().some((t) => t.includes("Shartnoma tekshiruvi")));
});

test("rasm, katta fayl, nomaʼlum tur va boʻsh skaner uchun tushunarli javob", async () => {
  const { calls, send, sent } = setup({ fileText: "   " });
  await send(message({ photo: [{ file_id: "p" }] }, 1));
  await send(message({ document: { file_id: "f", file_name: "a.pdf", file_size: 9e6 } }, 2));
  await send(message({ document: { file_id: "f", file_name: "a.xlsx", file_size: 10 } }, 3));
  await send(message({ document: { file_id: "f", file_name: "skaner.pdf", file_size: 10 } }, 4));
  const [photo, big, type, scan] = sent();
  assert.ok(photo.includes("Rasmlar hozircha oʻqilmaydi"));
  assert.ok(big.includes("4 MB"));
  assert.ok(type.includes("Faqat PDF, DOCX yoki TXT"));
  assert.ok(scan.includes("matn chiqmadi"));
  assert.equal(calls.ai.length, 0);
});

test("kunlik limit va bepul kvota tugashi", async () => {
  const { send, sent } = setup();
  await send(message({ text: SAMPLE }, 1));
  await send(message({ text: SAMPLE }, 2));
  await send(message({ text: SAMPLE }, 3));
  assert.ok(sent().at(-1).includes("Bugungi limit (2 ta tekshiruv) tugadi"));

  const quota = setup({ aiError: "3036: You have used up your daily free allocation of 10,000 neurons" });
  await quota.send(message({ text: SAMPLE }));
  assert.ok(quota.sent().at(-1).includes("bepul tahlil limiti tugadi"));
});

test("uy-joy shartnomasi boʻlmagan hujjat", async () => {
  const { send, sent } = setup({
    answer: { is_housing_contract: false, summary: "Bu ijara shartnomasi.", findings: [], other_risks: [] },
  });
  await send(message({ text: SAMPLE }));
  assert.ok(sent().at(-1).includes("oʻxshamaydi") && sent().at(-1).includes("ijara"));
  assert.equal(buildReport({ isHousingContract: false, summary: "" }).length, 1);
});
