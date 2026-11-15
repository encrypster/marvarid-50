# Ishonchli Shartnoma

Yangi qurilayotgan uydan xonadon sotib olish shartnomasini imzolashdan oldin
tekshirib beradigan Telegram Mini App va bot (`@ishonchli_shartnomabot`).
Xaridor shartnomani yuklaydi, ilova xavfli bandlarni iqtibos va amaldagi qonun
moddasi bilan koʻrsatadi, quruvchidan nimani soʻrashni aytadi va kutilayotgan
qonun kuchga kirsa nima oʻzgarishini prognoz qiladi.

Manzil: `https://uy-shartnoma-bot.encrypster.workers.dev` (Cloudflare Workers).

## Tuzilishi

| Qism | Fayl |
|---|---|
| Tekshiruv roʻyxati (12 band) | `data/checklist.json` |
| Qonunlar bazasi: amaldagi va kutilayotgan | `data/laws.json` |
| Worker: bot, API, tahlil | `worker/src/index.js` |
| Mini App sahifasi | `worker/src/app.html` |
| Namuna natija (ilovadagi "Namuna" tugmasi) | `worker/src/demo.json` |
| Sinov shartnomalari: nuqsonli va adolatli | `samples/` |
| Python nusxasi (Render yoki oʻz server uchun) | `shartnoma/` |

## Tahlil qanday ishlaydi

1. Fayl matnga aylantiriladi (PDF, DOCX, TXT; Cloudflare `toMarkdown`).
2. Pasport, JSHSHIR, telefon, karta, hisob raqam va email yashiriladi.
3. Ikki soʻrov parallel ketadi: tekshiruv roʻyxati boʻyicha tahlil va
   kutilayotgan qonun boʻyicha prognoz.
4. Model keltirgan har bir iqtibos shartnoma matnidan qidiriladi; topilmasa
   ogohlantirish chiqadi.
5. Kod biladigan narsalar modelga qoldirilmaydi: shartnoma tili harflarga qarab
   aniqlanadi; "bunday shart yoʻq" javobi shart yoʻqligi yaxshi boʻlgan
   bandlarda (masalan, pul ushlab qolish) muammo sanalmaydi; prognozdagi
   "imkoniyat/xavf" belgisi bazadan olinadi.
6. Huquqiy asos modeldan emas, `data/laws.json` dan olinadi.

### Qaysi model

- `ANTHROPIC_API_KEY` maxfiy qiymati boʻlsa — Claude (`claude-opus-5-5`,
  `CLAUDE_MODEL` oʻzgaruvchisi bilan almashtirsa boʻladi).
- Boʻlmasa — Cloudflare Workers AI: tahlil Llama 3.3 70B da, prognoz
  GLM 4.7 Flash da. Bepul tarifda kuniga 10 000 "neuron", bu taxminan 25 ta
  tekshiruv.

Bepul modellar ikki namuna shartnomada oʻlchangan (2026-11-15):

| Model | Nuqsonli namuna (11 muammo) | Adolatli namuna (0 muammo) |
|---|---|---|
| Llama 3.3 70B | 11/11, 11/11 | 1 ta soxta ogohlantirish |
| GPT-OSS 120B | 8/11, 11/11 | 1 ta soxta ogohlantirish |
| GLM 4.7 Flash | 10/11, 6/11 | 3 ta soxta ogohlantirish |
| Nemotron 3 120B | 6/11, 7/11 | oʻlchanmagan |

Koddagi tuzatishlar bilan Llama jonli sinovda nuqsonli namunada 11/11,
adolatli namunada 0 ta soxta ogohlantirish berdi. Claude yoʻli faqat soxta
javoblar bilan sinalgan; haqiqiy kalit bilan jonli sinov qilinmagan.

## Qonunlar bazasi

`data/laws.json` dagi amaldagi moddalar (PQ-4732 va uning Nizomi, Isteʼmolchilar
huquqlarini himoya qilish toʻgʻrisidagi Qonun, Fuqarolik kodeksi) lex.uz dan
soʻzma-soʻz olingan. Qaysi modda qaysi bandga tegishli ekanini va sodda izohlarni
yurist koʻrib chiqmagan.

Kutilayotgan qonun (Uy-joylarni ulushli qurish toʻgʻrisida) 2026-yil
10-noyabrda Qonunchilik palatasida qabul qilingan; Senat va Prezident
bosqichida. Rasmiy matni eʼlon qilinmagani uchun qoidalar OAV xabari asosida
berilgan. Qonun imzolangach `laws.json` ni rasmiy matn bilan yangilash kerak.

## Joylash va sinash

```bash
cd worker
npm install
npm test                                   # 19 ta test, tarmoqsiz
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

Maxfiy qiymatlar (Cloudflare: Worker → Settings → Variables and Secrets):

- `TELEGRAM_BOT_TOKEN` — majburiy. Almashtirilsa, `/setup` manzilini bir marta
  oching: webhook va botdagi "Tekshirish" menyu tugmasi qayta oʻrnatiladi.
- `ANTHROPIC_API_KEY` — ixtiyoriy, platform.claude.com dan.

Sahifa Worker toʻplamining ichida beriladi (statik fayl sifatida emas).

## Cheklovlar

- Rasm va skanerlangan PDF oʻqilmaydi.
- Bepul tarifda har soʻrovga 10 ms protsessor vaqti; juda uzun shartnomada
  yetmasligi mumkin. Tahlil 40–55 soniya oladi.
- Fayllar tashqi AI xizmatiga yuboriladi; shaxsga doir maʼlumotlar
  qonunchiligiga mosligini yurist tasdiqlashi kerak.
- Yuridik maslahat xizmatlari reyestri (VMQ 675-son) bunday ilovaga
  taalluqlimi, aniqlanmagan.
- Toʻlov ulanmagan; faqat kunlik limit bor (`DAILY_LIMIT`, hozir 5).

## Python nusxasi

`shartnoma/` papkasida botning Claude bilan ishlaydigan Python nusxasi bor
(polling yoki webhook, `Dockerfile`, `render.yaml`). U Mini App va prognozni
oʻz ichiga olmaydi.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q
```
