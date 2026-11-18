// Kirish nuqtasi: Mini App sahifasi, shriftlar va namuna natijani Worker toʻplamining
// ichidan beradi, qolgan soʻrovlarni index.js ga uzatadi.
import appHtml from "./app.html";
import demo from "./demo.json" with { type: "json" };
import bot from "./index.js";

import onestLatin from "./fonts/onest-latin.woff2";
import onestCyrillic from "./fonts/onest-cyrillic.woff2";
import onestCyrillicExt from "./fonts/onest-cyrillic-ext.woff2";
import plexLatin400 from "./fonts/plex-mono-latin-400.woff2";
import plexLatin500 from "./fonts/plex-mono-latin-500.woff2";
import plexCyrillic400 from "./fonts/plex-mono-cyrillic-400.woff2";
import plexCyrillicExt400 from "./fonts/plex-mono-cyrillic-ext-400.woff2";

const FONTS = {
  "onest-latin.woff2": onestLatin,
  "onest-cyrillic.woff2": onestCyrillic,
  "onest-cyrillic-ext.woff2": onestCyrillicExt,
  "plex-mono-latin-400.woff2": plexLatin400,
  "plex-mono-latin-500.woff2": plexLatin500,
  "plex-mono-cyrillic-400.woff2": plexCyrillic400,
  "plex-mono-cyrillic-ext-400.woff2": plexCyrillicExt400,
};

// ...bot: cron (scheduled) va boshqa ishlovchilar ham uzatiladi; ularni yoʻqotish kunlik kuzatuvni toʻxtatadi.
export default {
  ...bot,
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") {
      return new Response(appHtml, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (request.method === "GET" && pathname === "/demo.json") return Response.json(demo);
    if (request.method === "GET" && pathname.startsWith("/fonts/")) {
      const font = FONTS[pathname.slice("/fonts/".length)];
      if (!font) return new Response("topilmadi", { status: 404 });
      return new Response(font, {
        headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    return bot.fetch(request, env, ctx);
  },
};
