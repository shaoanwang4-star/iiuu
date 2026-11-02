/**
 * 灌入演示数据：node scripts/seed.mjs [http://127.0.0.1:8787]
 * 走真实上传接口，顺便验证 R2 与 ADMIN_TOKEN。
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const TOKEN = process.env.ADMIN_TOKEN || "dev123";
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "sample-assets");

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error || ""}`);
  return data;
};

const upload = async (path, field, files) => {
  const fd = new FormData();
  for (const f of files) {
    const buf = await readFile(join(ASSETS, f.name));
    fd.append(field, new File([buf], f.name, { type: f.type || "image/png" }));
  }
  const res = await fetch(BASE + path, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error || ""}`);
  return data;
};

const png = (name) => ({ name, type: "image/png" });
const comics = [
  { title: "霓虹夜行", author: "阿婆", category: "都市", description: "霓虹灯下的送饭日常。", chapters: 2, pages: 3 },
  { title: "海风与旧书店", author: "小满", category: "治愈", description: "海边旧书店里的来客。", chapters: 1, pages: 4 },
  { title: "机甲食堂", author: "阿婆", category: "科幻", description: "开着机甲卖炒面。", chapters: 1, pages: 6 },
];

const all = (await readdir(ASSETS)).filter((n) => n.endsWith(".png"));
if (!all.length) throw new Error(`${ASSETS} 下没有 png`);
const pick = (n) => all.slice(0, Math.min(n, all.length)).map(png);

for (const c of comics) {
  const { id } = await post("/api/comics", c);
  await upload(`/api/comics/${id}/cover`, "file", pick(1));
  for (let ch = 1; ch <= c.chapters; ch++) {
    const { id: chapterId } = await post(`/api/comics/${id}/chapters`, { title: `第${ch}话` });
    await upload(`/api/chapters/${chapterId}/pages`, "files", pick(c.pages));
  }
  console.log(`✓ ${c.title} (id=${id}, ${c.chapters} 话)`);
}
console.log(`\n完成，打开 ${BASE}/`);
