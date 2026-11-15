// Kirish nuqtasi: Mini App sahifasi va namuna natijani Worker toʻplamining ichidan beradi,
// qolgan soʻrovlarni index.js ga uzatadi. Sahifa alohida statik fayl emas, chunki u
// kod bilan birga bitta toʻplamda joylanadi.
import appHtml from "./app.html";
import demo from "./demo.json" with { type: "json" };
import bot from "./index.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") {
      return new Response(appHtml, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (request.method === "GET" && pathname === "/demo.json") return Response.json(demo);
    return bot.fetch(request, env, ctx);
  },
};
