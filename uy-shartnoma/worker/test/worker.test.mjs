import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import worker, {
  buildReport,
  buildView,
  languageFinding,
  parseAnalysis,
  parseForecast,
  quoteInText,
  redact,
  splitMessages,
  toPlain,
  verifyInitData,
  webhookSecret,
} from "../src/index.js";

const SAMPLE = readFileSync(new URL("../../samples/namuna_shartnoma.txt", import.meta.url), "utf8");
const CHECKLIST = JSON.parse(readFileSync(new URL("../../data/checklist.json", import.meta.url), "utf8")).items;
// Til kodda aniqlanadi; model faqat qolgan bandlarni baholaydi.
const MODEL_ITEMS = CHECKLIST.filter((item) => item.id !== "shartnoma_tili");
const TOKEN = "123456:TEST-TOKEN";
const ORIGIN = "https://bot.example.workers.dev";
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const GLM = "@cf/zai-org/glm-4.7-flash";

function modelAnswer(overrides = {}) {
  const findings = MODEL_ITEMS.map((item) => ({
    check_id: item.id,
    status: "joyida",
    quote: "",
    explanation: "Joyida.",
  }));
  findings[0] = {
    check_id: MODEL_ITEMS[0].id,
    status: "muammo",
    quote: "taxminan 2027-yilning toʻrtinchi choragida foydalanishga",
    explanation: "Aniq sana yoʻq.",
  };
  findings[1] = {
    check_id: MODEL_ITEMS[1].id,
    status: "muammo",
    quote: "Quruvchi hech qanday javobgar emas", // shartnomada yoʻq
    explanation: "Toʻqilgan iqtibos.",
  };
  findings.push({ check_id: "nomalum", status: "muammo", quote: "", explanation: "x" });
  const forecast = [
    { provision_id: "yq_eskrou", explanation: "Pulingiz bankda turadi." },
    { provision_id: "yq_toqilgan", explanation: "Roʻyxatda yoʻq qoida." },
    { provision_id: "yq_eskrou", explanation: "Takror." },
    { provision_id: "yq_narx", kind: "imkoniyat", explanation: "Narx oshishi mumkin." },
  ];
  return { is_housing_contract: true, summary: "Qisqa <xulosa>.", findings, other_risks: [], forecast, ...overrides };
}

/** Soxta muhit: Workers AI, KV, Telegram va Claude API oʻrniga xotiradagi nusxalar. */
function setup({ answer = modelAnswer(), aiError = null, fileText = SAMPLE, claude = false, claudeReply = null } = {}) {
  const kv = new Map();
  const calls = { ai: [], telegram: [], converted: [], claude: [] };
  const { forecast, ...findings } = answer;
  const reply = (isForecast) => JSON.stringify(isForecast ? { forecast: forecast ?? [] } : findings);
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
        // Haqiqiy model javobi OpenAI uslubida keladi.
        const isForecast = input.response_format.json_schema.name === "prognoz";
        return { choices: [{ message: { content: reply(isForecast) } }] };
      },
      toMarkdown: async (file) => {
        calls.converted.push(file.name);
        return { name: file.name, format: "text", data: fileText };
      },
    },
  };
  if (claude) env.ANTHROPIC_API_KEY = "sk-ant-test";

  globalThis.fetch = async (url, init) => {
    const request = url instanceof Request ? url : new Request(url, init);
    const target = request.url;
    if (target.startsWith("https://api.anthropic.com/")) {
      const body = await request.json();
      calls.claude.push({ path: new URL(target).pathname, headers: Object.fromEntries(request.headers), body });
      if (claudeReply) return claudeReply();
      const isForecast = body.output_config.format.schema.required.includes("forecast");
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: reply(isForecast) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    if (target.includes("/file/bot")) return new Response("fayl mazmuni");
    const method = target.split("/").pop();
    calls.telegram.push({ method, body: await request.json() });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: "docs/a.pdf" } });
    return Response.json({ ok: true });
  };

  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const send = async (update, secret) => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/webhook`, {
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
  const api = (init) => worker.fetch(new Request(`${ORIGIN}/api/check`, { method: "POST", ...init }), env, ctx);
  const sent = () => calls.telegram.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
  return { env, calls, send, sent, ctx, api };
}

/** Telegram Mini App yuboradigan imzolangan initData ni yasaydi. */
function signInitData(userId, { token = TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const fields = { auth_date: String(authDate), query_id: "AAE", user: JSON.stringify({ id: userId, first_name: "Sinov" }) };
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
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
  assert.equal(parsed.findings.length, MODEL_ITEMS.length);
  assert.ok(parsed.findings.every((f) => f.check_id !== "nomalum"));
  assert.equal(parseAnalysis("<think>{x}</think>" + JSON.stringify(modelAnswer())).findings.length, MODEL_ITEMS.length);
  for (const bad of ["javob yoʻq", "{buzilgan json}", undefined]) assert.throws(() => parseAnalysis(bad));
});

test("prognoz: toʻqilgan va takror qoidalar tashlanadi, belgi bazadan olinadi", () => {
  const forecast = parseForecast({ forecast: modelAnswer().forecast });
  assert.deepEqual(
    forecast.map((f) => [f.provision_id, f.kind]),
    [
      ["yq_amal_doirasi", "xavf"], // har doim birinchi boʻlib qoʻshiladi
      ["yq_eskrou", "imkoniyat"],
      ["yq_narx", "xavf"], // model "imkoniyat" degan, bazadagi belgi ustun
    ],
  );
  assert.deepEqual(parseForecast({ forecast: [{ provision_id: "yq_amal_doirasi", explanation: "x" }] }), []);
  assert.throws(() => parseForecast("buzuq"));
});

test("til harflarga qarab aniqlanadi", () => {
  assert.equal(languageFinding(SAMPLE).status, "joyida");
  assert.equal(languageFinding("Қурувчи ушбу шартномани ҳисобга қўйдиради ва ғолиб бўлади").status, "joyida");
  const russian = languageFinding("Застройщик обязуется передать квартиру дольщику в установленный срок");
  assert.equal(russian.status, "muammo");
  assert.ok(russian.explanation.includes("rus tilida"));
});

test("xabarlar Telegram chegarasiga sigʻadi", () => {
  const messages = splitMessages(["a".repeat(30), "b".repeat(30), Array(5).fill("c".repeat(20)).join("\n")], 50);
  assert.ok(messages.every((m) => m.length <= 50));
  assert.equal(messages.join("").split("c").length - 1, 100);
});

test("notoʻgʻri maxfiy sarlavha rad etiladi; /health va /setup ishlaydi", async () => {
  const { env, calls, send, ctx } = setup();
  assert.equal((await send(message({ text: "/start" }), "notogri")).status, 401);
  assert.equal(calls.telegram.length, 0);

  const health = await worker.fetch(new Request(`${ORIGIN}/health`), env, ctx);
  assert.equal(await health.text(), "ok");

  await worker.fetch(new Request(`${ORIGIN}/setup`), env, ctx);
  const [hook, menu] = calls.telegram.slice(-2);
  assert.equal(hook.method, "setWebhook");
  assert.equal(hook.body.url, `${ORIGIN}/webhook`);
  assert.equal(hook.body.secret_token, await webhookSecret(TOKEN));
  assert.equal(menu.method, "setChatMenuButton");
  assert.equal(menu.body.menu_button.web_app.url, `${ORIGIN}/`);
});

test("/start ilova tugmasi bilan salomlashadi; takroriy yangilanish ikkinchi marta ishlanmaydi", async () => {
  const { calls, send, sent } = setup();
  await send(message({ text: "/start" }));
  await send(message({ text: "/start" }));
  assert.equal(sent().length, 1);
  assert.ok(sent()[0].startsWith("Assalomu alaykum"));
  assert.equal(calls.telegram[0].body.reply_markup.inline_keyboard[0][0].web_app.url, `${ORIGIN}/`);
});

test("matnli shartnoma (bepul modellar): yashirilgan matn ketadi, hisobot qonun va prognoz bilan qaytadi", async () => {
  const { calls, send, sent } = setup();
  await send(message({ text: SAMPLE }));

  assert.deepEqual(calls.ai.map((c) => c.model).sort(), [LLAMA, GLM].sort());
  const findingsCall = calls.ai.find((c) => c.model === LLAMA);
  const forecastCall = calls.ai.find((c) => c.model === GLM);
  const prompt = findingsCall.input.messages[1].content;
  assert.ok(prompt.includes("[PASPORT]") && !prompt.includes("AB1234567"));
  const system = findingsCall.input.messages[0].content;
  assert.ok(system.includes(MODEL_ITEMS[0].id) && !system.includes("shartnoma_tili") && !system.includes("yq_eskrou"));
  assert.equal(findingsCall.input.response_format.type, "json_schema");
  assert.equal(findingsCall.input.chat_template_kwargs, undefined);
  assert.equal(forecastCall.input.chat_template_kwargs.enable_thinking, false);
  assert.ok(forecastCall.input.messages[0].content.includes("yq_eskrou"));
  assert.ok(forecastCall.input.messages[1].content.includes("[PASPORT]"));
  assert.equal(calls.claude.length, 0);

  const report = sent().slice(1).join("\n\n");
  assert.ok(sent()[0].startsWith("Tekshiryapman"));
  assert.ok(report.includes("Muammoli bandlar: 2 · Aniqlanmadi: 0"));
  assert.ok(report.includes("&lt;xulosa&gt;") && !report.includes("<xulosa>"));
  assert.equal(report.split("iqtibos matndan topilmadi").length - 1, 1);
  assert.ok(toPlain(report).includes(MODEL_ITEMS[0].ask_developer));
  assert.ok(report.includes("3 ta shaxsiy maʼlumot yashirildi"));
  assert.ok(report.includes("Huquqiy asos:</i> Nizom, 18-band"));
  assert.ok(report.includes("• Shartnoma tili")); // kod aniqlagan band "Joyida" roʻyxatida
  assert.ok(report.includes("Yangi qonun kuchga kirsa") && report.includes("Pulingiz bankda turadi."));
  assert.ok(report.includes("Faqat yangi qurilishlarga tatbiq etiladi") && !report.includes("Roʻyxatda yoʻq qoida"));
  assert.ok(report.includes("huquqiy maslahat emas"));
});

test("shartning yoʻqligi yaxshi boʻlgan bandlarda 'yoq' muammo sanalmaydi", async () => {
  const answer = modelAnswer();
  const absenceOk = MODEL_ITEMS.find((item) => item.absence_ok);
  const required = MODEL_ITEMS.find((item) => !item.absence_ok && item.id !== MODEL_ITEMS[0].id && item.id !== MODEL_ITEMS[1].id);
  for (const f of answer.findings) if (f.check_id === absenceOk.id || f.check_id === required.id) f.status = "yoq";
  const { api } = setup({ answer });
  const { report } = await (await api({ headers: { "x-telegram-init-data": signInitData(42) }, body: SAMPLE })).json();
  const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
  assert.equal(byId[absenceOk.id].group, "good");
  assert.equal(byId[required.id].group, "bad");
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

test("kunlik limit, bepul kvota tugashi va boʻsh javob", async () => {
  const { send, sent } = setup();
  await send(message({ text: SAMPLE }, 1));
  await send(message({ text: SAMPLE }, 2));
  await send(message({ text: SAMPLE }, 3));
  assert.ok(sent().at(-1).includes("Bugungi limit (2 ta tekshiruv) tugadi"));

  const quota = setup({ aiError: "3036: You have used up your daily free allocation of 10,000 neurons" });
  await quota.send(message({ text: SAMPLE }));
  assert.ok(quota.sent().at(-1).includes("bepul tahlil limiti tugadi"));

  const empty = setup({ answer: { is_housing_contract: true, summary: "", findings: [], other_risks: [] } });
  await empty.send(message({ text: SAMPLE }));
  assert.ok(empty.sent().at(-1).includes("Tahlil chiqmadi"));
});

test("uy-joy shartnomasi boʻlmagan hujjat; prognoz chiqmasa ham hisobot beriladi", async () => {
  const other = setup({
    answer: { is_housing_contract: false, summary: "Bu ijara shartnomasi.", findings: [], other_risks: [] },
  });
  await other.send(message({ text: SAMPLE }));
  assert.ok(other.sent().at(-1).includes("oʻxshamaydi") && other.sent().at(-1).includes("ijara"));
  assert.equal(buildReport({ isHousingContract: false, summary: "" }).length, 1);
  assert.equal(buildView({ isHousingContract: false, summary: "x", hidden: 0 }).findings.length, 0);

  const noForecast = setup({ answer: { ...modelAnswer(), forecast: "buzuq" } });
  await noForecast.send(message({ text: SAMPLE }));
  const report = noForecast.sent().slice(1).join("\n");
  assert.ok(report.includes("Shartnoma tekshiruvi") && !report.includes("Yangi qonun kuchga kirsa"));
});

test("Mini App imzosi: toʻgʻri, buzilgan, begona token va eskirgan", async () => {
  assert.equal(await verifyInitData(signInitData(42), TOKEN), 42);
  assert.equal(await verifyInitData(signInitData(42).replace("Sinov", "Boshqa"), TOKEN), null);
  assert.equal(await verifyInitData(signInitData(42, { token: "999:BEGONA" }), TOKEN), null);
  assert.equal(await verifyInitData(signInitData(42, { authDate: Math.floor(Date.now() / 1000) - 90000 }), TOKEN), null);
  assert.equal(await verifyInitData("", TOKEN), null);
  assert.equal(await verifyInitData("user=%7B%22id%22%3A42%7D&auth_date=1", TOKEN), null);
});

test("Mini App API: imzosiz rad etiladi, matn va fayl tekshiriladi, limit ishlaydi", async () => {
  const { calls, api } = setup();
  const denied = await api({ body: SAMPLE });
  assert.equal(denied.status, 401);
  assert.equal(calls.ai.length, 0);

  const headers = { "x-telegram-init-data": signInitData(42) };
  const data = await (await api({ headers, body: SAMPLE })).json();
  assert.ok(data.ok);
  const { report } = data;
  assert.equal(report.engine, "workers-ai");
  assert.deepEqual(report.counts, { bad: 2, unclear: 0, good: CHECKLIST.length - 2 });
  const first = report.findings[0];
  assert.equal(first.id, MODEL_ITEMS[0].id);
  assert.ok(first.laws.some((law) => law.ref === "Nizom, 18-band" && law.text.includes("ikki yildan kam boʻlmasligi") && law.url.includes("lex.uz")));
  assert.equal(report.findings.filter((f) => f.unverified).length, 1);
  assert.deepEqual(
    report.forecast.map((f) => [f.title, f.kind]),
    [
      ["Faqat yangi qurilishlarga tatbiq etiladi", "xavf"],
      ["Pul eskrou hisobvaragʻida saqlanadi", "imkoniyat"],
      ["Uy-joy narxi oshishi mumkin", "xavf"],
    ],
  );
  assert.ok(report.forecast[1].rule.includes("eskrou"));
  assert.ok(report.upcoming.status.includes("Senat"));

  const file = await (await api({ headers: { ...headers, "x-file-name": encodeURIComponent("Шартнома.pdf") }, body: "pdf baytlari" })).json();
  assert.ok(file.ok);
  assert.deepEqual(calls.converted, ["Шартнома.pdf"]);

  const limited = await (await api({ headers, body: SAMPLE })).json();
  assert.equal(limited.ok, false);
  assert.ok(limited.error.includes("Bugungi limit"));

  const short = await (await setup().api({ headers, body: "qisqa" })).json();
  assert.ok(short.error.includes("juda qisqa"));
});

test("qonunlar API va bilimlar bazasi yaxlitligi", async () => {
  const { env, ctx } = setup();
  const laws = await (await worker.fetch(new Request(`${ORIGIN}/api/laws`), env, ctx)).json();
  const ids = new Set(laws.current.flatMap((doc) => doc.provisions.map((p) => p.id)));
  for (const item of CHECKLIST) for (const ref of item.law_refs) assert.ok(ids.has(ref), ref);
  assert.ok(laws.current.every((doc) => doc.url.startsWith("https://lex.uz/")));
  assert.ok(laws.upcoming[0].stages.some((stage) => !stage.done));
});

test("Claude kaliti boʻlsa tahlil Claude'da ishlaydi", async () => {
  const { calls, api } = setup({ claude: true });
  const headers = { "x-telegram-init-data": signInitData(42) };
  const { ok, report } = await (await api({ headers, body: SAMPLE })).json();
  assert.ok(ok);
  assert.equal(report.engine, "claude");
  assert.deepEqual(report.counts, { bad: 2, unclear: 0, good: CHECKLIST.length - 2 });
  assert.equal(calls.ai.length, 0);
  assert.equal(calls.claude.length, 2);

  const findings = calls.claude.find((c) => !c.body.output_config.format.schema.required.includes("forecast"));
  const forecast = calls.claude.find((c) => c !== findings);
  assert.equal(findings.path, "/v1/messages");
  assert.equal(findings.headers.authorization, "Bearer sk-ant-test"); // SDK 1.x kalitni shu sarlavhada yuboradi
  assert.ok(findings.headers["anthropic-beta"].includes("server-side-fallback-2026-07-01"));
  assert.equal(findings.body.model, "claude-opus-5-5");
  assert.equal(findings.body.fallbacks, "default");
  assert.equal(findings.body.output_config.format.type, "json_schema");
  assert.equal(findings.body.output_config.effort, "medium");
  assert.equal(forecast.body.output_config.effort, "low");
  assert.deepEqual(findings.body.system[0].cache_control, { type: "ephemeral" });
  assert.ok(findings.body.messages[0].content.includes("[PASPORT]") && !findings.body.messages[0].content.includes("AB1234567"));
  for (const key of ["thinking", "temperature", "betas"]) assert.equal(findings.body[key], undefined);
});

test("Claude xatolari foydalanuvchiga tushunarli xabar boʻlib qaytadi", async () => {
  const headers = { "x-telegram-init-data": signInitData(42) };
  const error = (status, type) => () =>
    Response.json({ type: "error", error: { type, message: "x" } }, { status, headers: { "x-should-retry": "false" } });

  const badKey = await (await setup({ claude: true, claudeReply: error(401, "authentication_error") }).api({ headers, body: SAMPLE })).json();
  assert.ok(!badKey.ok && badKey.error.includes("sozlanmagan"));

  const busy = await (await setup({ claude: true, claudeReply: error(429, "rate_limit_error") }).api({ headers, body: SAMPLE })).json();
  assert.ok(busy.error.includes("Xizmat band"));

  const refusal = () =>
    Response.json({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 0 } });
  const refused = await (await setup({ claude: true, claudeReply: refusal }).api({ headers, body: SAMPLE })).json();
  assert.ok(refused.error.includes("Tahlil chiqmadi"));
});
