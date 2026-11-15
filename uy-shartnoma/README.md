# Uy shartnomasi tekshiruvchisi

Yangi qurilayotgan uydan xonadon sotib olish shartnomasini imzolashdan oldin
tekshirib beradigan Telegram bot. Xaridor shartnomani yuboradi, bot xavfli
bandlarni iqtibos bilan koʻrsatadi va quruvchidan nimani soʻrashni aytadi.

Tekshiruv roʻyxati (`data/checklist.json`, 12 band) Raqobat qoʻmitasining
132 ta quruvchi shartnomasi boʻyicha 2026-yil 6-noyabrdagi tahliliga asoslangan.

## Cloudflare'da ishga tushirish (tavsiya etiladi)

`worker/` papkasida botning Cloudflare Workers uchun yozilgan nusxasi bor. Unga
alohida hosting ham, Anthropic kaliti ham kerak emas: model Cloudflare Workers AI
dan olinadi (`@cf/zai-org/glm-4.7-flash`, bepul tarifda kuniga 10 000 "neuron").

Bot joylangan: `https://uy-shartnoma-bot.encrypster.workers.dev`, Telegram
webhook shu manzilga ulangan. Kod oʻzgargach qayta joylash:

```bash
cd worker
npm install
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

Bot tokeni Worker'da `TELEGRAM_BOT_TOKEN` nomli maxfiy qiymat sifatida saqlanadi
(`npx wrangler secret put TELEGRAM_BOT_TOKEN`). Token almashsa, yangisini qoʻyib,
`/setup` manzilini bir marta oching.

KV ombori (`uy-shartnoma-bot`) hisobda yaratilgan va `wrangler.jsonc` ga yozilgan.

Python nusxasidan farqlari:

- Rasm va skanerlangan PDF oʻqilmaydi; faqat matnli PDF, DOCX, TXT va yozib
  yuborilgan matn.
- Model ochiq va bepul. Namuna shartnomada 26 soniyada 12 banddan 10 tasini
  toʻgʻri baholadi (kafolat boʻyicha ikki bandni "aniqlanmadi" dedi). Haqiqiy
  shartnomalarda sifatni tekshirish kerak. Modelning "oʻylash" rejimi ataylab
  oʻchirilgan: yoqilsa javob 100 soniyaga choʻziladi va JSON buziladi.
  Modelni `wrangler.jsonc` dagi `MODEL` orqali almashtirsa boʻladi.
- Bepul tarifda har soʻrovga 10 ms protsessor vaqti beriladi; juda uzun
  shartnomada yetmasligi mumkin.

Testlar: `cd worker && npm test`.

## Python nusxasi (Render yoki oʻz serveringiz uchun)

### Ishga tushirish

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

export ANTHROPIC_API_KEY=...      # console.anthropic.com
export TELEGRAM_BOT_TOKEN=...     # @BotFather

# Bitta faylni terminalda tekshirish
.venv/bin/python -m shartnoma.cli samples/namuna_shartnoma.txt

# Botni ishga tushirish
.venv/bin/python -m shartnoma.bot

# Testlar (API kalitisiz ishlaydi)
.venv/bin/python -m pytest -q
```

## Qanday ishlaydi

1. `extract.py` fayldan matn oladi (PDF, DOCX, TXT). Rasm va skanerlangan PDF
   modelga fayl sifatida yuboriladi.
2. `redact.py` matndagi pasport, JSHSHIR, telefon, karta, hisob raqam va
   emailni yashiradi.
3. `analyzer.py` matnni tekshiruv roʻyxati bilan birga Claude modeliga yuboradi
   va har bir band boʻyicha tuzilgan javob oladi.
4. Model keltirgan har bir iqtibos shartnoma matnidan qidiriladi. Topilmasa,
   hisobotda ogohlantirish chiqadi — bu toʻqilgan iqtiboslardan himoya.
5. `report.py` natijani Telegram xabarlariga aylantiradi.

Bot ataylab qonun moddalarini aytmaydi: roʻyxatdagi `legal_basis` maydonlari
yurist tomonidan tasdiqlanmagan (`legal_verified: false`).

## Hali qilinmagan ishlar

- **Haqiqiy model bilan sinov.** Kod API kalitisiz, soxta javoblar bilan
  sinalgan. Birinchi ish — namuna va 20–30 ta haqiqiy shartnomada tekshirish.
- **Yurist tekshiruvi.** Har bir band uchun huquqiy asosni yurist toʻldirishi
  va tasdiqlashi kerak. Ulushli qurilish toʻgʻrisidagi yangi qonun 2026-yil
  10-noyabrda Qonunchilik palatasida qabul qilingan, Senat va Prezident
  bosqichida; kuchga kirgach roʻyxatni yangilash kerak.
- **Shaxsiy maʼlumotlar.** Fayllar xorijdagi API ga yuboriladi. Bu shaxsga doir
  maʼlumotlar toʻgʻrisidagi qonun talablariga mosligini yurist bilan aniqlang.
  Rasm va skanerlarda maʼlumot yashirilmaydi.
- **Yuridik maqom.** Yuridik maslahat xizmatlari reyestri (VMQ 675-son) bunday
  botga taalluqlimi, aniqlanmagan.
- **Toʻlov.** Hozircha faqat kunlik limit bor (`DAILY_LIMIT`), toʻlov ulanmagan.
- **Holat xotirada.** Limit hisobi bot qayta ishga tushsa nolga tushadi.
- **Koʻp sahifali rasm.** Har bir rasm alohida tekshiriladi; toʻliq shartnoma
  uchun bitta PDF kerak.
