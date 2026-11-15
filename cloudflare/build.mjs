// ../ik509 dagi fayllarni Worker ichiga joylaydi (src/assets.gen.js). Deploydan oldin ishga tushadi.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = new URL("../ik509/", import.meta.url);
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8", txt: "text/plain; charset=utf-8", svg: "image/svg+xml", png: "image/png" };
const out = {};
const names = readdirSync(dir).filter((n) => TYPES[n.split(".").pop()]).sort();
// Versiya — barcha fayllar mazmunidan; index.html ichidagi __APP_VERSION__ o'rniga yoziladi va /version.json da beriladi.
const all = createHash("sha1");
for (const name of names) all.update(name).update(readFileSync(new URL(name, dir)));
const version = all.digest("hex").slice(0, 12);
for (const name of names) {
  const type = TYPES[name.split(".").pop()];
  let buf = readFileSync(new URL(name, dir));
  if (name === "index.html") buf = Buffer.from(buf.toString("utf8").replace("__APP_VERSION__", version));
  out["/" + name] = { type, etag: '"' + createHash("sha1").update(buf).digest("hex").slice(0, 16) + '"', b64: buf.toString("base64") };
}
const vbuf = Buffer.from(JSON.stringify({ v: version }));
out["/version.json"] = { type: TYPES.json, etag: '"' + version + '"', b64: vbuf.toString("base64") };
writeFileSync(new URL("src/assets.gen.js", import.meta.url), "export default " + JSON.stringify(out) + ";\n");
console.log("version:", version, "assets:", Object.keys(out).join(" "));
