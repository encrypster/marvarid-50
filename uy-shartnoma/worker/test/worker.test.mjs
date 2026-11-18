import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import worker, {
  adminCode,
  buildReport,
  buildView,
  languageFinding,
  lawIndexes,
  parseAnalysis,
  parseForecast,
  quoteInText,
  redact,
  splitMessages,
  toPlain,
  verifyInitData,
  webhookSecret,
} from "../src/index.js";
import { htmlToText, lexId, parseDigest, parseEditions, refresh, resetLawsCache, stripNotes } from "../src/laws.js";

const SAMPLE = readFileSync(new URL("../../samples/namuna_shartnoma.txt", import.meta.url), "utf8");
const CHECKLIST = JSON.parse(readFileSync(new URL("../../data/checklist.json", import.meta.url), "utf8")).items;
// Til kodda aniqlanadi; model faqat qolgan bandlarni baholaydi.
const MODEL_ITEMS = CHECKLIST.filter((item) => item.id !== "shartnoma_tili");
const TOKEN = "123456:TEST-TOKEN";
const ORIGIN = "https://bot.example.workers.dev";

// Jonli bazaning kichik nusxasi: haqiqiyda uni kunlik kuzatuv KV ga yozadi.
const LAWS_VIEW = {
  checkedAt: "2026-11-15T01:17:00.000Z",
  pending: [],
  current: [
    {
      id: "-4831129",
      title: "Ulush kiritish asosida qurish tartibi",
      doc: "PQ-4732, 27.05.2020",
      url: "https://lex.uz/docs/-4831129",
      provisions: [
        { id: "d4831129_1", ref: "Nizom, 18-band", plain: "Shartnomada topshirish muddati boʻlishi lozim.", text: "qurilish obyektini ulushdorga topshirish muddati va holati;" },
        { id: "d4831129_2", ref: "Nizom, 28-band", plain: "Hisobga qoʻyilmagan shartnoma haqiqiy emas.", text: "hisobga qoʻyilmagan shartnomalar haqiqiy emas deb hisoblanadi." },
      ],
    },
  ],
  upcoming: [
    {
      title: "Ulushli qurilish toʻgʻrisidagi qonun",
      status: "Senat koʻrib chiqishini kutmoqda.",
      applies_note: "Faqat yangi qurilishlarga.",
      stages: [{ name: "Qonunchilik palatasi", done: true, date: "2026-11-10" }, { name: "Senat", done: false, date: "" }],
      provisions: [
        { id: "u1_1", title: "Eskrou hisobvaragʻi", kind: "imkoniyat", text: "Pul eskrou hisobvaragʻiga tushadi.", source: "https://example.uz/a" },
        { id: "u1_2", title: "Narx oshishi mumkin", kind: "xavf", text: "Uy-joy qiymati oshishi mumkin.", source: "https://example.uz/b" },
      ],
    },
  ],
};

function modelAnswer(overrides = {}) {
  const findings = MODEL_ITEMS.map((item) => ({
    check_id: item.id,
    status: "joyida",
    quote: "",
    explanation: "Joyida.",
    law_refs: [],
    law_note: "",
  }));
  findings[0] = {
    check_id: MODEL_ITEMS[0].id,
    status: "muammo",
    quote: "taxminan 2027-yilning toʻrtinchi choragida foydalanishga",
    explanation: "Aniq sana yoʻq.",
    law_refs: ["d4831129_1", "toqilgan_modda", "d4831129_1"],
    law_note: "Nizomga koʻra muddat shartnomada boʻlishi lozim.",
  };
  findings[1] = {
    check_id: MODEL_ITEMS[1].id,
    status: "muammo",
    quote: "Quruvchi hech qanday javobgar emas", // shartnomada yoʻq
    explanation: "Toʻqilgan iqtibos.",
    law_refs: ["toqilgan_modda"],
    law_note: "Fuqarolik kodeksining 999-moddasiga koʻra…", // asossiz: koʻrsatilmasligi kerak
  };
  findings.push({ check_id: "nomalum", status: "muammo", quote: "", explanation: "x", law_refs: [], law_note: "" });
  const forecast = [
    { provision_id: "u1_1", explanation: "Pulingiz bankda turadi." },
    { provision_id: "u9_9", explanation: "Bazada yoʻq qoida." },
    { provision_id: "u1_1", explanation: "Takror." },
    { provision_id: "u1_2", explanation: "Narx oshishi mumkin." },
  ];
  return { is_housing_contract: true, summary: "Qisqa <xulosa>.", findings, other_risks: [], forecast, ...overrides };
}

/** Soxta muhit: KV, Telegram va Claude API oʻrniga xotiradagi nusxalar. */
function setup({ answer = modelAnswer(), fileText = SAMPLE, laws = LAWS_VIEW, claudeKey = true, claudeReply = null } = {}) {
  resetLawsCache();
  const kv = new Map();
  if (laws) kv.set("laws:view", JSON.stringify(laws));
  const calls = { telegram: [], converted: [], claude: [] };
  const { forecast, ...findings } = answer;
  const env = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    DAILY_LIMIT: "2",
    KV: {
      get: async (key, type) => {
        const value = kv.get(key) ?? null;
        return value && type === "json" ? JSON.parse(value) : value;
      },
      put: async (key, value) => void kv.set(key, value),
    },
    AI: {
      toMarkdown: async (file) => {
        calls.converted.push(file.name);
        return { name: file.name, format: "text", data: fileText };
      },
    },
  };
  if (claudeKey) env.ANTHROPIC_API_KEY = "sk-ant-test";

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
        content: [{ type: "text", text: JSON.stringify(isForecast ? { forecast: forecast ?? [] } : findings) }],
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
  const get = (path) => worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx);
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
  return { env, calls, send, sent, ctx, api, get };
}

/** Telegram Mini App yuboradigan imzolangan initData ni yasaydi. */
function signInitData(userId, { token = TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const fields = { auth_date: String(authDate), query_id: "AAE", user: JSON.stringify({ id: userId, first_name: "Sinov" }) };
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const signed = () => ({ "x-telegram-init-data": signInitData(42) });

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

test("huquqiy asos faqat bazadagi normalardan: toʻqilgan havola va asossiz izoh tashlanadi", () => {
  const { lawIndex, upIndex } = lawIndexes(LAWS_VIEW);
  const parsed = parseAnalysis("```json\n" + JSON.stringify(modelAnswer()) + "\n```", lawIndex);
  assert.equal(parsed.findings.length, MODEL_ITEMS.length);
  assert.ok(parsed.findings.every((f) => f.check_id !== "nomalum"));
  assert.deepEqual(parsed.findings[0].law_refs, ["d4831129_1"]);
  assert.ok(parsed.findings[0].law_note.includes("Nizomga koʻra"));
  assert.deepEqual(parsed.findings[1].law_refs, []);
  assert.equal(parsed.findings[1].law_note, ""); // bazada asosi yoʻq huquqiy daʼvo koʻrsatilmaydi
  for (const bad of ["javob yoʻq", "{buzilgan json}", undefined]) assert.throws(() => parseAnalysis(bad, lawIndex));

  assert.deepEqual(
    parseForecast({ forecast: modelAnswer().forecast }, upIndex).map((f) => [f.provision_id, f.kind]),
    [["u1_1", "imkoniyat"], ["u1_2", "xavf"]],
  );
  assert.deepEqual(parseForecast({ forecast: modelAnswer().forecast }, new Map()), []);
});

test("til harflarga qarab aniqlanadi", () => {
  assert.equal(languageFinding(SAMPLE).status, "joyida");
  assert.equal(languageFinding("Қурувчи ушбу шартномани ҳисобга қўйдиради ва ғолиб бўлади").status, "joyida");
  assert.equal(languageFinding("Застройщик обязуется передать квартиру дольщику в установленный срок").status, "muammo");
});

test("xabarlar Telegram chegarasiga sigʻadi", () => {
  const messages = splitMessages(["a".repeat(30), "b".repeat(30), Array(5).fill("c".repeat(20)).join("\n")], 50);
  assert.ok(messages.every((m) => m.length <= 50));
  assert.equal(messages.join("").split("c").length - 1, 100);
});

test("webhook himoyasi, /health, /setup va /start", async () => {
  const { calls, send, sent, get } = setup();
  assert.equal((await send(message({ text: "/start" }), "notogri")).status, 401);
  assert.equal(calls.telegram.length, 0);
  const health = await (await get("/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.claude, true);
  assert.equal(health.laws.checkedAt, LAWS_VIEW.checkedAt);
  assert.equal(health.laws.stale, true); // namunadagi sana eski

  await get("/setup");
  const [hook, menu] = calls.telegram.slice(-2);
  assert.equal(hook.body.url, `${ORIGIN}/webhook`);
  assert.equal(hook.body.secret_token, await webhookSecret(TOKEN));
  assert.equal(menu.body.menu_button.web_app.url, `${ORIGIN}/`);

  await send(message({ text: "/start" }));
  await send(message({ text: "/start" })); // takroriy yangilanish ikkinchi marta ishlanmaydi
  assert.equal(sent().length, 1);
  assert.equal(calls.telegram.at(-1).body.reply_markup.inline_keyboard[0][0].web_app.url, `${ORIGIN}/`);
});

test("chatdagi hisobot: iqtibos, jonli bazadan huquqiy asos va prognoz", async () => {
  const { calls, send, sent } = setup();
  await send(message({ text: SAMPLE }));
  assert.equal(calls.claude.length, 2);
  const report = sent().slice(1).join("\n\n");
  assert.ok(sent()[0].startsWith("Tekshiryapman"));
  assert.ok(report.includes("Muammoli bandlar: 2 · Aniqlanmadi: 0"));
  assert.ok(report.includes("&lt;xulosa&gt;") && !report.includes("<xulosa>"));
  assert.equal(report.split("iqtibos matndan topilmadi").length - 1, 1);
  assert.ok(toPlain(report).includes(MODEL_ITEMS[0].ask_developer));
  assert.ok(report.includes("Huquqiy asos:</i> Ulush kiritish asosida qurish tartibi, Nizom, 18-band"));
  assert.ok(report.includes("Qonun boʻyicha:</i> Nizomga koʻra"));
  assert.ok(!report.includes("999-modda") && !report.includes("toqilgan_modda"));
  assert.ok(report.includes("• Shartnoma tili"));
  assert.ok(report.includes("Yangi qonun kuchga kirsa") && report.includes("Pulingiz bankda turadi."));
  assert.ok(!report.includes("Bazada yoʻq qoida") && !report.includes("Takror."));
  assert.ok(report.includes("3 ta shaxsiy maʼlumot yashirildi") && report.includes("huquqiy maslahat emas"));
});

test("shartning yoʻqligi yaxshi boʻlgan bandlarda 'yoq' muammo sanalmaydi", async () => {
  const answer = modelAnswer();
  const absenceOk = MODEL_ITEMS.find((item) => item.absence_ok);
  const required = MODEL_ITEMS.find((item) => !item.absence_ok && item.id !== MODEL_ITEMS[0].id && item.id !== MODEL_ITEMS[1].id);
  for (const f of answer.findings) if (f.check_id === absenceOk.id || f.check_id === required.id) f.status = "yoq";
  const { report } = await (await setup({ answer }).api({ headers: signed(), body: SAMPLE })).json();
  const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
  assert.equal(byId[absenceOk.id].group, "good");
  assert.equal(byId[required.id].group, "bad");
});

test("fayllar: PDF matnga aylantiriladi; rasm, katta fayl, nomaʼlum tur va boʻsh skaner rad etiladi", async () => {
  const ok = setup();
  await ok.send(message({ document: { file_id: "f1", file_name: "Shartnoma.PDF", file_size: 1000 } }));
  assert.deepEqual(ok.calls.converted, ["Shartnoma.PDF"]);
  assert.ok(ok.sent().some((t) => t.includes("Shartnoma tekshiruvi")));

  const { calls, send, sent } = setup({ fileText: "   " });
  await send(message({ photo: [{ file_id: "p" }] }, 1));
  await send(message({ document: { file_id: "f", file_name: "a.pdf", file_size: 9e6 } }, 2));
  await send(message({ document: { file_id: "f", file_name: "a.xlsx", file_size: 10 } }, 3));
  await send(message({ document: { file_id: "f", file_name: "skaner.pdf", file_size: 10 } }, 4));
  const [photo, big, type, scan] = sent();
  assert.ok(photo.includes("Rasmlar hozircha oʻqilmaydi") && big.includes("4 MB"));
  assert.ok(type.includes("Faqat PDF, DOCX yoki TXT") && scan.includes("matn chiqmadi"));
  assert.equal(calls.claude.length, 0);
});

test("kunlik limit, boʻsh javob, boshqa turdagi hujjat va kalitsiz holat", async () => {
  const { send, sent } = setup();
  await send(message({ text: SAMPLE }, 1));
  await send(message({ text: SAMPLE }, 2));
  await send(message({ text: SAMPLE }, 3));
  assert.ok(sent().at(-1).includes("Bugungi limit (2 ta tekshiruv) tugadi"));

  const empty = setup({ answer: { is_housing_contract: true, summary: "", findings: [], other_risks: [] } });
  await empty.send(message({ text: SAMPLE }));
  assert.ok(empty.sent().at(-1).includes("Tahlil chiqmadi"));

  const other = setup({ answer: { is_housing_contract: false, summary: "Bu ijara shartnomasi.", findings: [], other_risks: [] } });
  await other.send(message({ text: SAMPLE }));
  assert.ok(other.sent().at(-1).includes("oʻxshamaydi") && other.sent().at(-1).includes("ijara"));
  assert.equal(buildReport({ isHousingContract: false, summary: "" }).length, 1);
  assert.equal(buildView({ isHousingContract: false, summary: "x", hidden: 0 }).findings.length, 0);

  const noKey = setup({ claudeKey: false });
  const data = await (await noKey.api({ headers: signed(), body: SAMPLE })).json();
  assert.ok(!data.ok && data.error.includes("sozlanmagan"));
  assert.equal(noKey.calls.claude.length, 0);
});

test("Mini App imzosi: toʻgʻri, buzilgan, begona token va eskirgan", async () => {
  assert.equal(await verifyInitData(signInitData(42), TOKEN), 42);
  assert.equal(await verifyInitData(signInitData(42).replace("Sinov", "Boshqa"), TOKEN), null);
  assert.equal(await verifyInitData(signInitData(42, { token: "999:BEGONA" }), TOKEN), null);
  assert.equal(await verifyInitData(signInitData(42, { authDate: Math.floor(Date.now() / 1000) - 90000 }), TOKEN), null);
  assert.equal(await verifyInitData("", TOKEN), null);
});

test("Mini App API: Claude'ga jonli normalar beriladi, natijada asos matni bazadan olinadi", async () => {
  const { calls, api } = setup();
  assert.equal((await api({ body: SAMPLE })).status, 401);
  assert.equal(calls.claude.length, 0);

  const data = await (await api({ headers: signed(), body: SAMPLE })).json();
  assert.ok(data.ok);
  const { report } = data;
  assert.deepEqual(report.counts, { bad: 2, unclear: 0, good: CHECKLIST.length - 2 });
  assert.equal(report.lawsCheckedAt, LAWS_VIEW.checkedAt);
  const [first, second] = report.findings;
  assert.deepEqual(first.laws, [{ doc: "Ulush kiritish asosida qurish tartibi", ref: "Nizom, 18-band", text: LAWS_VIEW.current[0].provisions[0].text, plain: LAWS_VIEW.current[0].provisions[0].plain, url: "https://lex.uz/docs/-4831129", edition: "" }]);
  assert.ok(first.lawNote.includes("Nizomga koʻra"));
  assert.deepEqual(second.laws, []);
  assert.equal(second.lawNote, "");
  assert.equal(report.findings.filter((f) => f.unverified).length, 1);
  assert.deepEqual(report.forecast.map((f) => [f.title, f.kind, f.rule, f.source]), [
    ["Eskrou hisobvaragʻi", "imkoniyat", "Pul eskrou hisobvaragʻiga tushadi.", "https://example.uz/a"],
    ["Narx oshishi mumkin", "xavf", "Uy-joy qiymati oshishi mumkin.", "https://example.uz/b"],
  ]);
  assert.deepEqual(report.upcoming, [{ title: LAWS_VIEW.upcoming[0].title, status: LAWS_VIEW.upcoming[0].status, applies_note: "Faqat yangi qurilishlarga." }]);

  const findings = calls.claude.find((c) => !c.body.output_config.format.schema.required.includes("forecast"));
  const forecast = calls.claude.find((c) => c !== findings);
  assert.equal(findings.headers.authorization, "Bearer sk-ant-test");
  assert.ok(findings.headers["anthropic-beta"].includes("server-side-fallback-2026-07-01"));
  assert.equal(findings.body.model, "claude-opus-5-5");
  assert.equal(findings.body.fallbacks, "default");
  assert.equal(findings.body.output_config.effort, "medium");
  assert.equal(forecast.body.output_config.effort, "low");
  const system = findings.body.system[0].text;
  assert.ok(system.includes("d4831129_2") && system.includes("hisobga qoʻyilmagan shartnomalar haqiqiy emas"));
  assert.ok(system.includes("xotirangdagi huquqiy bilimni ishlatma") && !system.includes("shartnoma_tili"));
  assert.deepEqual(findings.body.output_config.format.schema.properties.findings.items.properties.law_refs.items.enum, ["d4831129_1", "d4831129_2"]);
  assert.ok(forecast.body.system[0].text.includes("u1_2") && forecast.body.system[0].text.includes("Faqat yangi qurilishlarga."));
  assert.deepEqual(forecast.body.output_config.format.schema.properties.forecast.items.properties.provision_id.enum, ["u1_1", "u1_2"]);
  assert.ok(findings.body.messages[0].content.includes("[PASPORT]") && !findings.body.messages[0].content.includes("AB1234567"));

  const file = await (await api({ headers: { ...signed(), "x-file-name": encodeURIComponent("Шартнома.pdf") }, body: "pdf baytlari" })).json();
  assert.ok(file.ok);
  assert.deepEqual(calls.converted, ["Шартнома.pdf"]);
  assert.ok((await (await api({ headers: signed(), body: SAMPLE })).json()).error.includes("Bugungi limit"));
  assert.ok((await (await setup().api({ headers: signed(), body: "qisqa" })).json()).error.includes("juda qisqa"));
});

test("baza boʻsh boʻlsa tahlil asossiz ishlaydi va prognoz soʻralmaydi", async () => {
  const { calls, api, get } = setup({ laws: null });
  const { ok, report } = await (await api({ headers: signed(), body: SAMPLE })).json();
  assert.ok(ok);
  assert.equal(calls.claude.length, 1);
  assert.ok(calls.claude[0].body.system[0].text.includes("Baza hozircha boʻsh"));
  assert.ok(report.findings.every((f) => f.laws.length === 0 && f.lawNote === ""));
  assert.deepEqual(report.forecast, []);
  assert.equal(report.lawsCheckedAt, null);
  assert.equal((await (await get("/api/laws")).json()).empty, true);
});

test("qonunlar API jonli bazani qaytaradi; boshqaruv manzili kalitsiz ochilmaydi", async () => {
  const { get } = setup();
  const laws = await (await get("/api/laws")).json();
  assert.equal(laws.checkedAt, LAWS_VIEW.checkedAt);
  assert.equal(laws.current[0].provisions.length, 2);
  assert.equal((await get("/admin/laws")).status, 401);
  assert.equal((await get("/admin/laws?key=notogri")).status, 401);
});

test("Claude xatolari foydalanuvchiga tushunarli xabar boʻlib qaytadi", async () => {
  const error = (status, type) => () =>
    Response.json({ type: "error", error: { type, message: "x" } }, { status, headers: { "x-should-retry": "false" } });
  const run = async (claudeReply) => (await (await setup({ claudeReply }).api({ headers: signed(), body: SAMPLE })).json()).error;
  assert.ok((await run(error(401, "authentication_error"))).includes("sozlanmagan"));
  assert.ok((await run(error(429, "rate_limit_error"))).includes("Xizmat band"));
  const refusal = () =>
    Response.json({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 0 } });
  assert.ok((await run(refusal)).includes("Tahlil chiqmadi"));
});

test("lex.uz sahifasi tozalanadi va manzil tekshiriladi", () => {
  const html = `<html><head><title>x</title><style>p{}</style></head><body><p>18. Shartnomada quyidagilar&nbsp;aks ettirilgan boʻlishi lozim:</p>
    <div>Ҳужжатга таклиф юборишАудиони тинглашҲужжат элементидан ҳавола олиш</div>
    <p>[ OKOZ: 1. 03.00.00.00 Fuqarolik qonunchiligi / 03.04.00.00 Majburiyat huquqi ]</p><p>Oldingi tahrirga qarang.</p>
    <p>kafolat muddati (ikki yildan kam boʻlmasligi lozim);</p><script>var a = "<p>";</script></body></html>`;
  assert.equal(htmlToText(html), "18. Shartnomada quyidagilar aks ettirilgan boʻlishi lozim:\nkafolat muddati (ikki yildan kam boʻlmasligi lozim);");
  assert.equal(lexId("https://lex.uz/uz/docs/-4831129?ONDATE=21.04.2022"), "-4831129");
  assert.equal(lexId("https://lex.uz/docs/5307951"), "5307951");
  for (const bad of ["https://example.com/docs/-1", "https://lex.uz/search?q=1", "", null]) assert.equal(lexId(bad), null);
});

test("normalar matni model yozganidan emas, iqtibos oraligʻidan olinadi", () => {
  const doc = "Kirish.\n18. Shartnomada topshirish muddati aks ettirilgan boʻlishi lozim.\nBoshqa band.\n28. Hisobga qoʻyilmagan shartnomalar haqiqiy emas.";
  const span = (needle) => ({ type: "char_location", start_char_index: doc.indexOf(needle), end_char_index: doc.indexOf(needle) + needle.length });
  const content = [
    { type: "text", text: "Mana normalar:\n" },
    { type: "text", text: "[Nizom, 18-band] Shartnomada topshirish muddati yozilishi kerak.", citations: [span("18. Shartnomada topshirish muddati"), span("aks ettirilgan boʻlishi lozim.")] },
    { type: "text", text: "\n[99-modda] Model oʻylab topgan, iqtibossiz norma.\n" },
    { type: "text", text: "[Nizom, 28-band] Hisobga qoʻyilmagan shartnoma haqiqiy emas.", citations: [span("28. Hisobga qoʻyilmagan shartnomalar haqiqiy emas.")] },
    { type: "text", text: "\nIzohsiz qator, qavssiz.", citations: [span("Boshqa band.")] },
  ];
  const { provisions, repealed } = parseDigest(content, doc);
  assert.equal(repealed, false);
  assert.deepEqual(provisions.map((p) => p.ref), ["Nizom, 18-band", "Nizom, 28-band"]);
  // Yonma-yon ikki iqtibos bitta uzluksiz parchaga birlashadi va hujjat matnining aynan oʻzi boʻladi.
  assert.equal(provisions[0].text, "18. Shartnomada topshirish muddati aks ettirilgan boʻlishi lozim.");
  assert.ok(doc.includes(provisions[1].text));
  assert.equal(parseDigest([{ type: "text", text: "KUCHINI YOʻQOTGAN" }], doc).repealed, true);
  // Tahrir tarixi izohi norma matni sifatida koʻrsatilmaydi.
  assert.equal(stripNotes("(260-moddaning birinchi qismi Oʻzbekiston Respublikasining 2021-yil 21-apreldagi OʻRQ-683-sonli Qonuni tahririda — Qonunchilik"), "");
  assert.equal(stripNotes("Neustoyka bilan faqat haqiqiy talab taʼminlanadi.\n(21-modda 2022-yil 18-yanvardagi Qonunga asosan uchinchi qism bilan toʻldirilgan — x)"), "Neustoyka bilan faqat haqiqiy talab taʼminlanadi.");
});

const editionsHtml = (selected, links) => `<html><head><title>x</title></head><body>
  <div class="dropdown-menu lx_date_ddm" aria-labelledby="dd3" id="lx_var_t" title="">
    ${links.map((d) => `<div class="dropdown-menu__item lx_date_link" onclick="lxOpenUrl('/docs/-111189?ONDATE=${d}')">${d}</div>`).join("")}
    <div class="dropdown-menu__item lx_date_selected stopProp">${selected}</div>
  </div></div>
  <p>${"Hujjat matni. ".repeat(300)}</p></body></html>`;

test("tahrir sanasi lex.uz roʻyxatidan olinadi; kelgusi tahrirlar ajratiladi", () => {
  const parsed = parseEditions(editionsHtml("12.09.2026 01", ["28.01.2027", "25.07.2026", "29.06.2026"]), "-111189");
  assert.equal(parsed.edition, "12.09.2026 01");
  assert.equal(parsed.editionDate, "2026-09-12");
  assert.deepEqual(parsed.future, [{ date: "2027-01-28", url: "https://lex.uz/docs/-111189?ONDATE=28.01.2027" }]);
  assert.deepEqual(parseEditions("<html>tahrirsiz</html>", "-1"), { edition: "", editionDate: "", future: [] });
  // Oʻzgartirilmagan hujjat: tahrirlar roʻyxati yoʻq, sana sarlavhadan olinadi.
  assert.deepEqual(parseEditions("<title>&nbsp;PF-11-сон 27.01.2025.&nbsp;Farmon</title><p>01.02.2025</p>", "-7353734"), { edition: "27.01.2025", editionDate: "2025-01-27", future: [] });
});

test("refresh: sana oʻzgarmasa matn qayta olinmaydi, yangi tahrirda olinadi", async () => {
  const kv = new Map();
  const env = { KV: { get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) } };
  kv.set("laws:registry", JSON.stringify({ in_force: [{ id: "-111189", lex_url: "https://lex.uz/docs/-111189" }] }));
  let page = editionsHtml("12.09.2026 01", ["28.01.2027"]);
  globalThis.fetch = async () => new Response(page);

  assert.match((await refresh(env))[0], /yangi hujjat, tahrir 2026-09-12/);
  const first = JSON.parse(kv.get("laws:doc:-111189"));
  assert.equal(first.edition, "12.09.2026 01");
  assert.ok(first.text.includes("Hujjat matni."));

  page = page.replace("Hujjat matni.", "Boshqa matn, lekin sana oʻsha."); // matn farqi hisobga olinmaydi
  assert.match((await refresh(env))[0], /oʻzgarmagan/);
  assert.ok(JSON.parse(kv.get("laws:doc:-111189")).text.includes("Hujjat matni."));

  page = editionsHtml("28.01.2027", []);
  assert.match((await refresh(env))[0], /YANGI TAHRIR 2027-01-28/);
  assert.deepEqual(JSON.parse(kv.get("laws:doc:-111189")).future, []);

  // Sana belgisi boʻlmagan eski yozuvga sana qayta oʻqishsiz biriktiriladi.
  kv.set("laws:doc:-111189", JSON.stringify({ id: "-111189", text: "eski" }));
  kv.set("laws:digest:-111189", JSON.stringify({ id: "-111189", provisions: [] }));
  assert.match((await refresh(env))[0], /biriktirildi/);
  assert.equal(JSON.parse(kv.get("laws:digest:-111189")).edition, "28.01.2027");
  assert.equal(JSON.parse(kv.get("laws:doc:-111189")).text, "eski");
});

test("kirish fayli cron chaqiruvlarini ham uzatadi", () => {
  // entry.js .html/.woff2 import qiladi, shuning uchun uni Node'da yuklab boʻlmaydi: manbasi tekshiriladi.
  const entry = readFileSync(new URL("../src/entry.js", import.meta.url), "utf8");
  assert.match(entry, /export default \{\s*\/\/[^\n]*\n?\s*\.\.\.bot,|export default \{\s*\.\.\.bot,/);
  assert.equal(typeof worker.scheduled, "function");
});

test("administrator: maxfiy havola bilan biriktiriladi, ogohlantirishlar kuniga bir marta", async () => {
  const { env, send, sent, calls } = setup();
  await send(message({ text: "/start admin_000000000000000000000000" }, 1));
  assert.equal(await env.KV.get("admin:chat"), null);
  await send(message({ text: `/start admin_${await adminCode(TOKEN)}` }, 2));
  assert.equal(await env.KV.get("admin:chat"), "7");
  assert.ok(sent().at(-1).includes("administrator sifatida"));

  await send(message({ text: "/privacy" }, 3));
  assert.ok(sent().at(-1).includes("Anthropic") && sent().at(-1).includes("saqlamaydi"));

  // Eskirgan baza: 3 soatlik cron ogohlantiradi, ikkinchi marta shu kuni yubormaydi.
  const before = calls.telegram.length;
  await worker.scheduled({ cron: "47 */3 * * *" }, env);
  await worker.scheduled({ cron: "47 */3 * * *" }, env);
  const alerts = calls.telegram.slice(before).filter((c) => c.method === "sendMessage");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].body.chat_id, 7);
  assert.ok(alerts[0].body.text.includes("yangilanmagan"));
});

test("umumiy kunlik chegara va Claude kaliti xatosida administratorga xabar", async () => {
  const limited = setup();
  limited.env.DAILY_GLOBAL_LIMIT = "1";
  await limited.env.KV.put("admin:chat", "99");
  assert.ok((await (await limited.api({ headers: signed(), body: SAMPLE })).json()).ok);
  const second = await (await limited.api({ headers: { "x-telegram-init-data": signInitData(43) }, body: SAMPLE })).json();
  assert.ok(!second.ok && second.error.includes("soʻrovlar juda koʻp"));
  assert.ok(limited.calls.telegram.some((c) => c.body.chat_id === 99 && c.body.text.includes("umumiy limit")));

  const badKey = setup({
    claudeReply: () => Response.json({ type: "error", error: { type: "authentication_error", message: "x" } }, { status: 401, headers: { "x-should-retry": "false" } }),
  });
  await badKey.env.KV.put("admin:chat", "99");
  await badKey.api({ headers: signed(), body: SAMPLE });
  const alert = badKey.calls.telegram.filter((c) => c.body.chat_id === 99);
  assert.equal(alert.length, 1); // ikki parallel soʻrov, lekin bitta xabar
  assert.ok(alert[0].body.text.includes("ANTHROPIC_API_KEY"));
});
