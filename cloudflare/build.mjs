// ../ik509 dagi fayllarni Worker ichiga joylaydi (src/assets.gen.js). Deploydan oldin ishga tushadi.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = new URL("../ik509/", import.meta.url);
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8", txt: "text/plain; charset=utf-8", svg: "image/svg+xml", png: "image/png" };
const out = {};
for (const name of readdirSync(dir)) {
  const type = TYPES[name.split(".").pop()];
  if (!type) continue;
  const buf = readFileSync(new URL(name, dir));
  out["/" + name] = { type, etag: '"' + createHash("sha1").update(buf).digest("hex").slice(0, 16) + '"', b64: buf.toString("base64") };
}
writeFileSync(new URL("src/assets.gen.js", import.meta.url), "export default " + JSON.stringify(out) + ";\n");
console.log("assets:", Object.keys(out).join(" "));
