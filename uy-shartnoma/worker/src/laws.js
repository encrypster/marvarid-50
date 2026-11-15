// Qonunlar bazasi: hech qanday qoʻlda yozilgan hujjatlar roʻyxati yoʻq.
//
// Har kuni (cron):
//   1. discover — Claude veb-qidiruv bilan amaldagi va kutilayotgan hujjatlarni topadi.
//   2. refresh  — lex.uz dagi amaldagi tahrir sanasi tekshiriladi; sana yangilangan boʻlsa matn qayta olinadi.
//   3. digest   — yangi tahriri chiqqan hujjatni Claude toʻliq oʻqib, tegishli normalarni ajratadi.
//
// Toʻqimaslik kafolati modelning vaʼdasiga emas, tekshiruvga tayanadi:
//   - amaldagi normalar matni Claude yozgan satr emas, API qaytargan iqtibos oraligʻi
//     (citations) — u hujjat matnining aynan oʻzi;
//   - kutilayotgan qonun qoidalari manba sahifasidan qayta olinib, iqtibos unda borligi tekshiriladi.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const KEY_REGISTRY = "laws:registry";
const KEY_VIEW = "laws:view";
const docKey = (id) => `laws:doc:${id}`;
const digestKey = (id) => `laws:digest:${id}`;

const MAX_DOCS = 12;
const MAX_UPCOMING_SOURCES = 6;
const FETCH_HEADERS = { "user-agent": "Mozilla/5.0 (compatible; IshonchliShartnoma/1.0)" };

const SUBJECT =
  "Oʻzbekistonda qurilayotgan koʻp kvartirali uydan xonadon sotib olayotgan fuqaro (ulushdor, isteʼmolchi) " +
  "va quruvchi oʻrtasidagi shartnoma: ulushli qurilish, shartnoma shartlari, muddatlar, neustoyka (penya), " +
  "narxni oʻzgartirish, shartnomani bekor qilish va pulni qaytarish, kafolat va nuqsonlar, isteʼmolchi huquqlari, " +
  "shartnomani roʻyxatdan oʻtkazish, ulushdorlar mablagʻini himoya qilish";

// ---------- Matn bilan ishlash ----------

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", laquo: "«", raquo: "»", mdash: "—", ndash: "–" };
// lex.uz sahifasidagi xizmat yozuvlari: hujjat matniga kirmaydi.
const NOISE = /Ҳужжатга таклиф юбориш|Аудиони тинглаш|Ҳужжат элементидан ҳавола олиш|Oldingi tahrirga qarang\.?|Keyingi tahrirga qarang\.?/g;
const NOISE_LINE = /^(\[?(OKOZ|ОКОЗ|TSZ|ТСЗ)\b.*|\d+\.\s\d{2}\.\d{2}\.\d{2}\.\d{2}\s.*|LexUZ sharhi.*)$/;

export function htmlToText(html) {
  const text = html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(NOISE, " ")
    // Tasniflagich bloklari: "[ OKOZ: 1. 03.00.00.00 ... ]" — hujjat matni emas.
    .replace(/\[\s*(?:OKOZ|ОКОЗ|TSZ|ТСЗ)\b[^\]]{0,2000}\]/g, " ");
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line && !NOISE_LINE.test(line))
    .join("\n");
}

export function normalize(text) {
  return text.replace(/[ʻʼ’‘`´ʹ']/g, "'").replace(/[«»“”„"]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

// Tahrir tarixi haqidagi izoh satrlari ("(260-moddaning birinchi qismi ... Qonuni tahririda — ...") norma emas.
const EDIT_NOTE = /^\(.*(tahririda|bilan toʻldirilgan|chiqarib tashlangan|Qonunchilik maʼlumotlari milliy bazasi|OʻR QHT)/;
export function stripNotes(text) {
  return text
    .split("\n")
    .filter((line) => !EDIT_NOTE.test(line.trim()))
    .join("\n")
    .replace(/^(?:…\n)+|(?:\n…)+$/g, "")
    .trim();
}

/** "https://lex.uz/uz/docs/-4831129?ONDATE=..." -> "-4831129"; boshqa manzil boʻlsa null. */
export function lexId(url) {
  const match = /^https?:\/\/(?:www\.)?lex\.uz\/(?:[a-z]{2}\/)?(?:docs|acts|mact)\/(-?\d+)/i.exec(String(url || "").trim());
  return match ? match[1] : null;
}
export const lexUrl = (id) => `https://lex.uz/docs/${id}`;

const isoDate = (ddmmyyyy) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(ddmmyyyy || "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
};

/**
 * lex.uz sahifasidagi tahrirlar roʻyxati ("Вариантлар"): lx_date_selected — hozir amaldagi tahrir,
 * undan keyingi sanalar — eʼlon qilingan, lekin hali kuchga kirmagan tahrirlar.
 * edition — taqqoslash uchun kalit (bir kunda ikki tahrir boʻlsa "12.09.2026 01" kabi raqami bilan).
 */
export function parseEditions(html, id) {
  const start = html.indexOf('id="lx_var_t"');
  // Roʻyxat sanalardan iborat qisqa blok; uning oxirini aniqlash oʻrniga yetarli oyna olinadi.
  const block = start === -1 ? "" : html.slice(start, start + 8000).split(/<\/div>\s*<\/div>\s*<\/div>/)[0];
  const selected = /lx_date_selected[^>]*>\s*([^<]+?)\s*(?:<|$)/.exec(block)?.[1] || "";
  const current = isoDate(selected);
  const future = [...block.matchAll(/ONDATE=(\d{2}\.\d{2}\.\d{4})/g)]
    .map((m) => isoDate(m[1]))
    .filter((date) => current && date > current)
    .filter((date, n, all) => all.indexOf(date) === n)
    .sort()
    .map((date) => ({ date, url: `${lexUrl(id)}?ONDATE=${date.split("-").reverse().join(".")}` }));
  if (current) return { edition: selected, editionDate: current, future };
  // Hech oʻzgartirilmagan hujjatda tahrirlar roʻyxati yoʻq: amaldagi tahrir — qabul qilingan sana (sarlavhada).
  const adopted = /<title>[^<]*?(\d{2}\.\d{2}\.\d{4})/i.exec(html)?.[1] || "";
  return { edition: adopted, editionDate: isoDate(adopted), future: [] };
}

function parseJson(raw) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Model JSON qaytarmadi");
  return JSON.parse(text.slice(start, end + 1));
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const now = () => new Date().toISOString();

// ---------- Claude ----------

function claude(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
}

/** Server vositalari bilan soʻrov: pause_turn boʻlsa davom ettiradi, yakuniy xabarni qaytaradi. */
async function runWithServerTools(client, params) {
  const messages = [...params.messages];
  for (let turn = 0; turn < 6; turn += 1) {
    const response = await client.messages.stream({ ...params, messages }).finalMessage();
    if (response.stop_reason !== "pause_turn") return response;
    messages.push({ role: "assistant", content: response.content });
  }
  throw new Error("Qidiruv juda uzoq davom etdi");
}

// ---------- 1. Hujjatlarni topish ----------

const DISCOVER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["in_force", "upcoming"],
  properties: {
    in_force: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "doc", "lex_url", "why"],
        properties: {
          title: { type: "string" },
          doc: { type: "string" },
          lex_url: { type: "string" },
          why: { type: "string" },
        },
      },
    },
    upcoming: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "status", "stages", "applies_note", "provisions"],
        properties: {
          title: { type: "string" },
          status: { type: "string" },
          stages: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "done", "date"],
              properties: { name: { type: "string" }, done: { type: "boolean" }, date: { type: "string" } },
            },
          },
          applies_note: { type: "string" },
          provisions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "kind", "quote", "source_url"],
              properties: {
                title: { type: "string" },
                kind: { type: "string", enum: ["imkoniyat", "xavf"] },
                quote: { type: "string" },
                source_url: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

function discoverPrompt(previous) {
  return `Bugun ${now().slice(0, 10)}. Sen Oʻzbekiston qonunchiligini kuzatuvchi tadqiqotchisan. Mavzu: ${SUBJECT}.

Veb-qidiruvdan foydalanib ikki roʻyxat tuz. Xotirangga emas, faqat hozir topgan manbalaringga tayan.

1) in_force — shu mavzuni tartibga soluvchi, BUGUN AMALDA boʻlgan normativ-huquqiy hujjatlar (kodekslar, qonunlar, Prezident va Vazirlar Mahkamasi qarorlari, nizomlar). Maxsus hujjatlar bilan birga shu munosabatlarga qoʻllanadigan umumiy qonunchilikni ham kirit (shartnoma, majburiyat va neustoyka haqidagi fuqarolik qonunchiligi, isteʼmolchilar huquqlarini himoya qilish). Har biri uchun lex.uz dagi rasmiy sahifa manzilini ber (https://lex.uz/docs/<raqam> koʻrinishida; manzilni qidiruv natijasidan ol, oʻylab topma). lex.uz hujjatlarini ochib oʻqish shart emas: ularning toʻliq matni keyin alohida oʻqiladi va kuchda ekani tekshiriladi. Kuchini yoʻqotgani maʼlum hujjatni kiritma. Eng muhim ${MAX_DOCS} tagacha hujjat. Maydonlar: title — qisqa nom; doc — turi, raqami va sanasi; why — nega shu mavzuga tegishli (bir gap).

2) upcoming — qabul qilingan, lekin hali kuchga kirmagan qonunlar va rasmiy muhokamadagi loyihalar (shu mavzuda). Har biri uchun: status — hozirgi holat bir-ikki gapda, sana bilan; stages — qabul bosqichlari tartib bilan (name, done, date: "YYYY-MM-DD" yoki boʻsh); applies_note — kimga va qachondan tatbiq etilishi (manbada aytilgan boʻlsa, aks holda boʻsh satr); provisions — xaridorga taʼsir qiladigan qoidalar.
   provisions qoidalari: title — qisqa nom; kind — xaridor uchun "imkoniyat" yoki "xavf"; quote — manba sahifasidan SOʻZMA-SOʻZ koʻchirilgan bir-ikki gap (tarjima qilma, qisqartirma, imlosini tuzatma — dastur uni sahifadan qidirib tekshiradi, topilmasa qoida tashlab yuboriladi); source_url — oʻsha sahifa manzili. Rasmiy matn eʼlon qilingan boʻlsa undan, boʻlmasa ishonchli OAV xabaridan ol.

Oldingi kuzatuv natijasi (tekshirish uchun, koʻr-koʻrona koʻchirma: har birini qayta tasdiqla, yangilarini qoʻsh, kuchini yoʻqotganini olib tashla):
${previous ? JSON.stringify(previous) : "yoʻq — bu birinchi kuzatuv"}

Javobing faqat bitta JSON obyekt boʻlsin.`;
}

export async function discover(env) {
  const previous = await env.KV.get(KEY_REGISTRY, "json");
  const hint = previous && {
    in_force: previous.in_force.map(({ title, doc, lex_url }) => ({ title, doc, lex_url })),
    upcoming: previous.upcoming.map(({ title, status }) => ({ title, status })),
  };
  const response = await runWithServerTools(claude(env), {
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema: DISCOVER_SCHEMA } },
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      // Faqat yangilik sahifalaridan iqtibos olish uchun; lex.uz hujjatlari keyin alohida toʻliq oʻqiladi.
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4, max_content_tokens: 8000 },
    ],
    messages: [{ role: "user", content: discoverPrompt(hint) }],
  });
  if (response.stop_reason !== "end_turn") throw new Error(`Kuzatuv yakunlanmadi: ${response.stop_reason}`);
  const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const found = parseJson(text);

  const seen = new Set();
  const inForce = [];
  for (const item of Array.isArray(found.in_force) ? found.in_force : []) {
    const id = lexId(item?.lex_url);
    if (!id || seen.has(id) || !str(item.title)) continue; // lex.uz dagi rasmiy sahifasi boʻlmagan hujjat qabul qilinmaydi
    seen.add(id);
    inForce.push({ id, title: str(item.title), doc: str(item.doc), why: str(item.why), lex_url: lexUrl(id) });
    if (inForce.length >= MAX_DOCS) break;
  }
  if (!inForce.length) throw new Error("Kuzatuv birorta amaldagi hujjat topmadi");

  const upcoming = await verifyUpcoming(Array.isArray(found.upcoming) ? found.upcoming : []);
  const registry = { checkedAt: now(), in_force: inForce, upcoming };
  await env.KV.put(KEY_REGISTRY, JSON.stringify(registry));
  return {
    in_force: inForce.map((d) => `${d.id} ${d.title}`),
    upcoming: upcoming.map((u) => `${u.title}: ${u.provisions.length} qoida (${u.dropped} tashlandi)`),
    usage: response.usage,
  };
}

/** Kutilayotgan qonun qoidalari: iqtibos manba sahifasida borligi tekshiriladi, boʻlmasa tashlanadi. */
async function verifyUpcoming(items) {
  const pages = new Map();
  async function page(url) {
    if (!pages.has(url)) {
      pages.set(
        url,
        pages.size >= MAX_UPCOMING_SOURCES
          ? ""
          : await fetch(url, { headers: FETCH_HEADERS })
              .then((r) => (r.ok ? r.text() : ""))
              .then((html) => normalize(htmlToText(html)))
              .catch(() => ""),
      );
    }
    return pages.get(url);
  }
  const result = [];
  for (const item of items) {
    if (!str(item?.title)) continue;
    const provisions = [];
    let dropped = 0;
    for (const p of Array.isArray(item.provisions) ? item.provisions : []) {
      const quote = str(p?.quote);
      const url = str(p?.source_url);
      const needle = normalize(quote).replace(/^[ .…"]+|[ .…"]+$/g, "");
      if (!/^https:\/\//.test(url) || needle.length < 20 || !(await page(url)).includes(needle)) {
        dropped += 1;
        continue;
      }
      provisions.push({
        id: `u${result.length + 1}_${provisions.length + 1}`,
        title: str(p.title),
        kind: p.kind === "xavf" ? "xavf" : "imkoniyat",
        text: quote,
        source: url,
      });
    }
    result.push({
      title: str(item.title),
      status: str(item.status),
      applies_note: str(item.applies_note),
      stages: (Array.isArray(item.stages) ? item.stages : [])
        .filter((s) => str(s?.name))
        .map((s) => ({ name: str(s.name), done: s.done === true, date: /^\d{4}-\d{2}-\d{2}$/.test(str(s.date)) ? str(s.date) : "" })),
      provisions,
      dropped,
    });
  }
  return result;
}

// ---------- 2. Toʻliq matnlarni yangilash ----------

export async function refresh(env) {
  const registry = await env.KV.get(KEY_REGISTRY, "json");
  if (!registry) throw new Error("Avval kuzatuv (discover) oʻtishi kerak");
  const log = [];
  for (const item of registry.in_force) {
    try {
      const response = await fetch(item.lex_url, { headers: FETCH_HEADERS });
      if (!response.ok) throw new Error(`lex.uz ${response.status}`);
      const html = await response.text();
      const { edition, editionDate, future } = parseEditions(html, item.id);
      if (!edition) throw new Error("tahrir sanasi topilmadi");
      const stored = await env.KV.get(docKey(item.id), "json");

      // Hujjat oʻzgargani amaldagi tahrir sanasidan bilinadi: matnni solishtirish shart emas.
      if (stored?.edition === edition) {
        await env.KV.put(docKey(item.id), JSON.stringify({ ...stored, future, checkedAt: now() }));
        log.push(`${item.id}: tahrir ${editionDate} — oʻzgarmagan`);
        continue;
      }
      // Sana belgisi joriy etilishidan oldin oʻqilgan hujjat: matnini qayta oʻqimasdan sanani biriktiramiz.
      const digest = await env.KV.get(digestKey(item.id), "json");
      if (stored && !stored.edition && digest) {
        await env.KV.put(docKey(item.id), JSON.stringify({ ...stored, edition, editionDate, future, checkedAt: now() }));
        await env.KV.put(digestKey(item.id), JSON.stringify({ ...digest, edition }));
        log.push(`${item.id}: tahrir ${editionDate} biriktirildi`);
        continue;
      }
      const text = htmlToText(html);
      if (text.length < 2000) throw new Error("matn juda qisqa");
      const pageTitle = htmlToText(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
      await env.KV.put(
        docKey(item.id),
        JSON.stringify({ id: item.id, pageTitle, text, edition, editionDate, future, changedAt: now(), checkedAt: now() }),
      );
      log.push(`${item.id}: ${stored ? `YANGI TAHRIR ${editionDate}` : `yangi hujjat, tahrir ${editionDate}`} (${text.length} belgi)`);
    } catch (error) {
      log.push(`${item.id}: xato — ${String(error?.message || error)}`);
    }
  }
  return log;
}

// ---------- 3. Hujjatni Claude oʻqib, normalarni ajratadi ----------

function digestPrompt(item) {
  return `Senga Oʻzbekiston normativ-huquqiy hujjatining lex.uz dan olingan TOʻLIQ matni berildi: «${item.title}» (${item.doc}).

Mavzu: ${SUBJECT}.

Hujjatni boshidan oxirigacha oʻqi va shu mavzuda xaridor (ulushdor, isteʼmolchi) huquqini belgilaydigan yoki shartnoma shartlariga talab qoʻyadigan HAR BIR normani top. Mavzuga aloqasi yoʻq normalarni yozma. Kuchini yoʻqotgan (matnda shunday belgilangan) normalarni yozma.

Har bir norma uchun aynan bitta qator yoz, shu shaklda:
[modda yoki band raqami] sodda oʻzbek tilida, lotin yozuvida bir gapli izoh.

Qoidalar:
- Har bir qator hujjat matnidan iqtibosga tayansin. Iqtibossiz qator hisobga olinmaydi.
- Izohda hujjatda yoʻq narsa (raqam, muddat, istisno) boʻlmasin.
- Kvadrat qavs ichida faqat manzil boʻlsin, masalan: [18-band], [260-modda, 1-qism], [1-band «a» kichik bandi]. Nizom yoki ilova ichidagi band boʻlsa shuni ayt: [Nizom, 18-band].
- Kirish soʻzi, xulosa, sarlavha yozma — faqat shu qatorlar.
- Agar hujjat boshida uning butunlay kuchini yoʻqotgani yozilgan boʻlsa, faqat bitta qator yoz: KUCHINI YOʻQOTGAN`;
}

/**
 * Model javobidagi qatorlarni iqtiboslari bilan yigʻadi. Norma matni sifatida model yozgan
 * satr emas, API qaytargan iqtibos oraligʻi (hujjat matnining aynan oʻzi) olinadi.
 */
export function parseDigest(content, docText) {
  const lines = [{ text: "", spans: [] }];
  for (const block of content) {
    if (block.type !== "text") continue;
    const spans = (block.citations || [])
      .filter((c) => c.type === "char_location" && Number.isInteger(c.start_char_index) && c.end_char_index > c.start_char_index)
      .map((c) => [c.start_char_index, c.end_char_index]);
    const parts = block.text.split("\n");
    parts.forEach((part, n) => {
      if (n > 0) lines.push({ text: "", spans: [] });
      const line = lines[lines.length - 1];
      line.text += part;
      // Iqtibos blok matni joylashgan qator(lar)ga tegishli.
      if (part.trim() && spans.length) line.spans.push(...spans);
    });
  }
  const provisions = [];
  for (const line of lines) {
    const match = /^\s*(?:[-•*]\s*)?\[([^\]]{1,80})\]\s*(.+)$/.exec(line.text);
    if (!match || !line.spans.length) continue; // iqtibossiz qator — asossiz, tashlanadi
    const merged = [];
    for (const [start, end] of line.spans.sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1] + 2) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    const text = merged.map(([start, end]) => docText.slice(start, end).trim()).filter(Boolean).join("\n…\n");
    if (text.length < 15) continue;
    provisions.push({ ref: match[1].trim(), plain: match[2].trim(), text });
  }
  const repealed = lines.some((line) => /^\s*KUCHINI YOʻQOTGAN\s*$/i.test(line.text)) && provisions.length === 0;
  return { provisions, repealed };
}

export async function digestOne(env, item) {
  const doc = await env.KV.get(docKey(item.id), "json");
  if (!doc) return `${item.id}: matn yoʻq`;
  const response = await claude(env).messages.stream({
    model: MODEL,
    max_tokens: 24000,
    output_config: { effort: "medium" },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "text", media_type: "text/plain", data: doc.text }, title: item.title, citations: { enabled: true } },
          { type: "text", text: digestPrompt(item) },
        ],
      },
    ],
  }).finalMessage();
  if (response.stop_reason !== "end_turn") throw new Error(`${item.id}: javob yakunlanmadi (${response.stop_reason})`);
  const { provisions, repealed } = parseDigest(response.content, doc.text);
  await env.KV.put(
    digestKey(item.id),
    JSON.stringify({
      id: item.id,
      edition: doc.edition,
      digestedAt: now(),
      repealed,
      provisions: provisions.map((p, n) => ({ id: `d${item.id.replace("-", "")}_${n + 1}`, ...p })),
    }),
  );
  return `${item.id}: ${repealed ? "KUCHINI YOʻQOTGAN" : `${provisions.length} norma`} (kirish ${response.usage.input_tokens} token)`;
}

/** Matni oʻzgargan yoki hali oʻqilmagan hujjatlarni vaqt yetguncha qayta ishlaydi. */
export async function digestPending(env, budgetMs = 10 * 60_000, only = null) {
  const registry = await env.KV.get(KEY_REGISTRY, "json");
  if (!registry) throw new Error("Avval kuzatuv (discover) oʻtishi kerak");
  const started = Date.now();
  const log = [];
  for (const item of registry.in_force) {
    if (only && item.id !== only) continue;
    const [doc, digest] = await Promise.all([env.KV.get(docKey(item.id), "json"), env.KV.get(digestKey(item.id), "json")]);
    if (!doc || (digest?.edition === doc.edition && !only)) continue;
    if (Date.now() - started > budgetMs) {
      log.push(`${item.id}: keyingi ishga tushishga qoldi`);
      continue;
    }
    try {
      log.push(await digestOne(env, item));
    } catch (error) {
      log.push(`${item.id}: xato — ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  return log;
}

// ---------- Koʻrinish: tahlil va ilova shu bitta yozuvdan oʻqiydi ----------

export async function buildLawsView(env) {
  const registry = await env.KV.get(KEY_REGISTRY, "json");
  if (!registry) return null;
  const current = [];
  const pending = [];
  for (const item of registry.in_force) {
    const [doc, digest] = await Promise.all([env.KV.get(docKey(item.id), "json"), env.KV.get(digestKey(item.id), "json")]);
    if (!doc || !digest) {
      pending.push(item.title);
      continue;
    }
    const provisions = digest.provisions
      .map((p) => ({ ...p, text: stripNotes(p.text) }))
      .filter((p) => p.text.length >= 15);
    if (digest.repealed || !provisions.length) continue;
    current.push({
      id: item.id,
      title: item.title,
      doc: item.doc,
      why: item.why,
      url: item.lex_url,
      editionDate: doc.editionDate || "",
      future: doc.future || [], // eʼlon qilingan, lekin hali kuchga kirmagan tahrirlar
      checkedAt: doc.checkedAt,
      stale: digest.edition !== doc.edition, // yangi tahrir chiqqan, normalar hali qayta oʻqilmagan
      provisions,
    });
  }
  const view = {
    checkedAt: registry.checkedAt,
    builtAt: now(),
    pending,
    current,
    upcoming: registry.upcoming.filter((u) => u.provisions.length || u.status),
  };
  await env.KV.put(KEY_VIEW, JSON.stringify(view));
  return view;
}

let cached = null;
/** Tahlil va API uchun: KV dagi koʻrinish, bir daqiqa xotirada saqlanadi. */
export async function getLawsView(env) {
  if (cached && Date.now() - cached.at < 60_000) return cached.view;
  const view = await env.KV.get(KEY_VIEW, "json");
  cached = { at: Date.now(), view };
  return view;
}
export function resetLawsCache() {
  cached = null;
}

/** Kunlik toʻliq sikl. Har bir qadam mustaqil: biri yiqilsa, oldingi maʼlumot saqlanib qoladi. */
export async function runDaily(env, steps = ["discover", "refresh", "digest"]) {
  const log = {};
  for (const step of steps) {
    try {
      if (step === "discover") log.discover = await discover(env);
      if (step === "refresh") log.refresh = await refresh(env);
      if (step === "digest") log.digest = await digestPending(env);
    } catch (error) {
      log[step] = `xato — ${String(error?.message || error).slice(0, 300)}`;
    }
  }
  const view = await buildLawsView(env);
  resetLawsCache();
  log.view = view
    ? { hujjatlar: view.current.length, normalar: view.current.reduce((n, d) => n + d.provisions.length, 0), kutilayotgan: view.upcoming.length, navbatda: view.pending }
    : "bazada hali maʼlumot yoʻq";
  return log;
}
