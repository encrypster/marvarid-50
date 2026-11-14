# Uy shartnomasi tekshiruvchisi

Yangi qurilayotgan uydan xonadon sotib olish shartnomasini imzolashdan oldin
tekshirib beradigan Telegram bot. Xaridor shartnomani yuboradi, bot xavfli
bandlarni iqtibos bilan koʻrsatadi va quruvchidan nimani soʻrashni aytadi.

Tekshiruv roʻyxati (`data/checklist.json`, 12 band) Raqobat qoʻmitasining
132 ta quruvchi shartnomasi boʻyicha 2026-yil 6-noyabrdagi tahliliga asoslangan.

## Ishga tushirish

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
