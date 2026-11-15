# Ishonchli Shartnoma

Yangi qurilayotgan uydan xonadon sotib olish shartnomasini imzolashdan oldin
tekshirib beradigan Telegram Mini App va bot (`@ishonchli_shartnomabot`).
Xaridor shartnomani yuklaydi; Claude xavfli bandlarni shartnomadan iqtibos va
amaldagi qonun normasi matni bilan koʻrsatadi, quruvchidan nimani soʻrashni
aytadi va kutilayotgan qonunlar kuchga kirsa nima oʻzgarishini prognoz qiladi.

Manzil: `https://uy-shartnoma-bot.encrypster.workers.dev` (Cloudflare Workers).

## Tuzilishi

| Qism | Fayl |
|---|---|
| Qonunlar kuzatuvi (Claude + lex.uz) | `worker/src/laws.js` |
| Bot, API, shartnoma tahlili | `worker/src/index.js` |
| Mini App sahifasi, shriftlar | `worker/src/app.html`, `worker/src/fonts/` |
| Tekshiruv roʻyxati (12 band) | `data/checklist.json` |
| Sinov shartnomalari: nuqsonli va adolatli | `samples/` |
| Brend fayllari | `brand/` |
| Eski Python nusxasi (qonunlar bazasisiz) | `shartnoma/` |

## Qonunlar bazasi: statik roʻyxat yoʻq

Kodda birorta ham qonun nomi, raqami yoki matni yozilmagan. Baza KV omborida
turadi va uni har kuni Claude yangilaydi (`worker/src/laws.js`):

1. **Kuzatuv** (`discover`). Claude veb-qidiruv bilan mavzuga tegishli amaldagi
   hujjatlarni (lex.uz manzili bilan) va hali kuchga kirmagan qonunlarni topadi.
   Oldingi kungi natija unga faqat qayta tekshirish uchun beriladi.
2. **Matnlar** (`refresh`). Har bir amaldagi hujjatning toʻliq matni lex.uz dan
   olinadi; oʻzgargan-oʻzgarmagani matn xeshi bilan aniqlanadi.
3. **Oʻqish** (`digest`). Matni yangi yoki oʻzgargan hujjatni Claude boshidan
   oxirigacha oʻqib, shartnomaga taalluqli har bir normani ajratadi.

Jadval: har kuni 01:17 UTC (Toshkentda 06:17) toʻliq sikl; har 3 soatda
oʻqilmay qolgan hujjatlar tugatiladi. Qoʻlda ishga tushirish:
`/admin/laws?key=<webhook maxfiy qiymati>&steps=discover,refresh,digest`.

### Claude toʻqimasligi qanday taʼminlanadi

Bu modelning vaʼdasiga emas, tekshiruvga tayanadi:

- **Amaldagi norma matni** Claude yozgan satr emas. Hujjat Claude'ga iqtibos
  (citations) rejimida beriladi va norma matni sifatida API qaytargan iqtibos
  oraligʻi — hujjat matnining aynan oʻzi — saqlanadi. Iqtibossiz qator tashlanadi.
- **Kutilayotgan qonun qoidasi** manba sahifasidan qayta yuklab olinib, iqtibos
  unda soʻzma-soʻz borligi tekshiriladi; topilmasa qoida tashlanadi.
- **Tekshiruvda** Claude'ga shu normalar roʻyxati beriladi va u huquqiy asosni
  faqat ularning `id` si orqali koʻrsata oladi (sxemada boshqa qiymat yoʻq).
  Ilovada koʻrinadigan norma matni bazadan olinadi. Bazada yoʻq normaga
  tayangan izoh koʻrsatilmaydi; asos topilmasa, shu ochiq aytiladi.
- **Shartnomadan iqtibos** shartnoma matnidan qidiriladi; topilmasa
  ogohlantirish chiqadi.

Chegarasi: qaysi hujjat va qaysi norma "tegishli" ekanini Claude tanlaydi, u
biror hujjatni oʻtkazib yuborishi mumkin. Sodda izohlar (norma nima deyishi)
ham Claude'niki va yurist koʻrigidan oʻtmagan. Butun Oʻzbekiston qonunchiligi
emas, faqat uy-joy shartnomasiga taalluqli hujjatlar kuzatiladi.

## Shartnoma tahlili

1. Fayl matnga aylantiriladi (PDF, DOCX, TXT). Rasm va skaner oʻqilmaydi.
2. Pasport, JSHSHIR, telefon, karta, hisob raqam va email yashiriladi.
3. Claude (`claude-opus-5-5`) ga ikki parallel soʻrov ketadi: 12 band boʻyicha
   tahlil (amaldagi normalar bilan) va kutilayotgan qonunlar boʻyicha prognoz.
4. Kod biladigan narsalar modelga qoldirilmaydi: til harflarga qarab aniqlanadi,
   umumiy baho va muhr muammolar sonidan hisoblanadi.

`ANTHROPIC_API_KEY` majburiy; bepul modelga oʻtish yoʻq.

## Xarajat (taxminiy, Claude Opus 5.5 narxida)

| Ish | Bir marta | Izoh |
|---|---|---|
| Kunlik kuzatuv | ~0,85 $ | 2026-11-15 da oʻlchangan: 182 ming kirish tokeni |
| Hujjatni oʻqish | 0,1–2,6 $ | faqat matn oʻzgarganda; Fuqarolik kodeksi eng qimmati |
| Bitta shartnoma tekshiruvi | ~0,5 $ (hisob-kitob) | 294 norma matni ≈ 100 ming kirish tokeni; 65–70 soniya |

Kunlik kuzatuv oyiga taxminan 25 $ boʻladi. Arzonlashtirish yoʻllari:
kuzatuvni haftada bir marta qilish (`wrangler.jsonc` dagi cron) yoki
`laws.js` dagi `MODEL` ni arzonroq modelga almashtirish.

## Brend

Gʻoya: hujjat va muhr. Oʻzbek hujjatlarida ishonch belgisi dumaloq koʻk muhr,
shuning uchun u logotip, bot rasmi va xulosa varagʻidagi baho belgisi sifatida
ishlatiladi. Qolgan hamma narsa sokin: oq varaq, siyoh-qora matn, ingichka
chiziqlar.

| Element | Qiymat |
|---|---|
| Asosiy rang (muhr siyohi) | `#2A3FC7`, tungi rejimda `#96A3FF` |
| Matn / fon | `#0F1430` / `#ECEEF4`, varaq `#FFFFFF` |
| Holat ranglari | xavf `#C2331F`, ehtiyot `#96590A`, joyida `#1B7548` |
| Matn va sarlavha shrifti | Onest (oʻzbekcha ʻ va kirillni qamraydi) |
| Iqtibos, yorliq va muhr yozuvi | IBM Plex Mono |
| Logotip va bot rasmi | `brand/logo-mark.svg`, `brand/avatar-512.png` |

Shriftlar (SIL OFL litsenziyasi) ilovaning oʻzidan beriladi: `worker/src/fonts/`.
Xulosa varagʻidagi muhr yozuvi bahoga qarab oʻzgaradi: "XAVFLI", "EHTIYOT
BOʻLING", "KAMCHILIK BOR" yoki "MUAMMO TOPILMADI". Aylana boʻylab har doim
"DASTLABKI TEKSHIRUV" yoziladi — bu rasmiy tasdiq emasligini bildiradi.

Bot profili (nomi, tavsifi, rasmi) Bot API orqali oʻrnatilgan.

## Joylash va sinash

```bash
cd worker
npm install
npm test                                   # 17 ta test, tarmoqsiz
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

Maxfiy qiymatlar (Cloudflare: Worker → Settings → Variables and Secrets):
`TELEGRAM_BOT_TOKEN` va `ANTHROPIC_API_KEY`. Token almashsa, `/setup`
manzilini bir marta oching.

## Cheklovlar

- Rasm va skanerlangan PDF oʻqilmaydi.
- Bepul Cloudflare tarifida protsessor vaqti cheklangan; hozircha katta
  hujjatlar ham oʻtmoqda, lekin kafolat yoʻq.
- Matnlar Anthropic API ga yuboriladi; shaxsga doir maʼlumotlar
  qonunchiligiga mosligini yurist tasdiqlashi kerak.
- Yuridik maslahat xizmatlari reyestri (VMQ 675-son) bunday ilovaga
  taalluqlimi, aniqlanmagan.
- Toʻlov ulanmagan; faqat kunlik limit bor (`DAILY_LIMIT`, hozir 5).
