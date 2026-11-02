/**
 * 漫画站 Worker API —— 只保留基础功能：浏览、搜索/分类、上传发布。
 * /api/* 由本 Worker 处理，其余路径交给静态资源(SPA)。
 * 写接口用单个 ADMIN_TOKEN（secret）鉴权，没有用户体系。
 */

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
]);

// ---------- 小工具 ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

const err = (msg, status = 400) => json({ error: msg }, status);

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256hex(text) {
  const bits = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function parseBody(request) {
  try { return await request.json(); } catch { return null; }
}

const like = (q) => `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;

/** 管理员令牌校验：未配置 501（fail closed），不匹配 401 */
async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return err("服务端未配置 ADMIN_TOKEN", 501);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer /i, "").trim();
  if (!token) return err("需要管理员令牌", 401);
  return (await sha256hex(token)) === (await sha256hex(env.ADMIN_TOKEN)) ? null : err("需要管理员令牌", 401);
}

// ---------- 上传 ----------

async function readImages(form, env, field = "files") {
  const entries = form.getAll(field).filter((f) => f instanceof File && f.size > 0);
  if (entries.length === 0) return { e: err("没有收到文件") };
  if (entries.length > 100) return { e: err("单次最多上传 100 张") };
  const maxMb = Number(env.MAX_UPLOAD_MB || 10);
  for (const f of entries) {
    if (!ALLOWED_IMAGE_TYPES.has(f.type)) return { e: err(`不支持的文件类型: ${f.type || f.name}`) };
    if (f.size > maxMb * 1024 * 1024) return { e: err(`文件 ${f.name} 超过 ${maxMb}MB 限制`) };
  }
  return { files: entries };
}

async function putImage(env, key, file) {
  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
}

// ---------- 查询 ----------

const LIST_SQL = `
  SELECT c.id, c.title, c.author, c.category, c.description, c.created_at,
    (SELECT COUNT(*) FROM chapters ch WHERE ch.comic_id = c.id) AS chapter_count,
    COALESCE(c.cover_key,
      (SELECT p.r2_key FROM pages p JOIN chapters ch ON ch.id = p.chapter_id
       WHERE ch.comic_id = c.id ORDER BY ch.num, p.idx LIMIT 1)) AS cover
  FROM comics c`;

const withCover = (row) => ({
  ...row,
  cover: row.cover || row.cover_key ? `/api/img/${row.cover || row.cover_key}` : null,
});

async function findComic(env, id) {
  return env.DB.prepare("SELECT * FROM comics WHERE id = ?").bind(id).first();
}

async function findChapter(env, id) {
  return env.DB.prepare(
    `SELECT ch.*, c.title AS comic_title FROM chapters ch JOIN comics c ON c.id = ch.comic_id
     WHERE ch.id = ?`).bind(id).first();
}

// ---------- 级联删除（D1 默认不启用外键）----------

async function deleteChapterCascade(env, chapterId) {
  const { results } = await env.DB.prepare("SELECT r2_key FROM pages WHERE chapter_id = ?").bind(chapterId).all();
  for (const p of results) await env.BUCKET.delete(p.r2_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pages WHERE chapter_id = ?").bind(chapterId),
    env.DB.prepare("DELETE FROM chapters WHERE id = ?").bind(chapterId),
  ]);
}

async function deleteComicCascade(env, comicId) {
  const { results: chapters } = await env.DB.prepare("SELECT id FROM chapters WHERE comic_id = ?").bind(comicId).all();
  for (const ch of chapters) await deleteChapterCascade(env, ch.id);
  const comic = await findComic(env, comicId);
  if (comic?.cover_key) await env.BUCKET.delete(comic.cover_key);
  await env.DB.prepare("DELETE FROM comics WHERE id = ?").bind(comicId).run();
}

// ---------- API 路由 ----------

const routes = [
  // ===== 浏览 =====
  ["GET", /^\/api\/comics$/, async (c, env) => {
    const p = new URL(c.req.url).searchParams;
    const q = String(p.get("q") || "").trim().slice(0, 30);
    const category = String(p.get("category") || "").trim().slice(0, 20);
    const where = [];
    const args = [];
    if (q) { where.push("(c.title LIKE ? ESCAPE '\\' OR c.author LIKE ? ESCAPE '\\')"); args.push(like(q), like(q)); }
    if (category && category !== "全部") { where.push("c.category = ?"); args.push(category); }
    const limit = Math.min(100, Math.max(1, Number(p.get("limit")) || 60));
    const offset = Math.max(0, Number(p.get("offset")) || 0);
    const { results } = await env.DB.prepare(
      `${LIST_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`)
      .bind(...args, limit, offset).all();
    return json({ comics: results.map(withCover) });
  }],

  ["GET", /^\/api\/categories$/, async (c, env) => {
    const { results } = await env.DB.prepare(
      "SELECT category, COUNT(*) AS count FROM comics GROUP BY category ORDER BY category").all();
    return json({ categories: results });
  }],

  ["GET", /^\/api\/comics\/(\d+)$/, async (c, env, m) => {
    const comic = await findComic(env, Number(m[1]));
    if (!comic) return err("漫画不存在", 404);
    const { results: chapters } = await env.DB.prepare(
      `SELECT id, num, title,
         (SELECT COUNT(*) FROM pages p WHERE p.chapter_id = ch.id) AS page_count
       FROM chapters ch WHERE comic_id = ? ORDER BY num`).bind(comic.id).all();
    return json({
      comic: withCover(comic),
      chapters,
    });
  }],

  ["GET", /^\/api\/chapters\/(\d+)$/, async (c, env, m) => {
    const ch = await findChapter(env, Number(m[1]));
    if (!ch) return err("章节不存在", 404);
    const { results: pages } = await env.DB.prepare(
      "SELECT id, idx, r2_key FROM pages WHERE chapter_id = ? ORDER BY idx").bind(ch.id).all();
    const sibling = (dir) => env.DB.prepare(
      `SELECT id FROM chapters WHERE comic_id = ? AND num ${dir} ? ORDER BY num ${dir === ">" ? "ASC" : "DESC"} LIMIT 1`)
      .bind(ch.comic_id, ch.num).first();
    const [next, prev] = await Promise.all([sibling(">"), sibling("<")]);
    return json({
      chapter: { id: ch.id, num: ch.num, title: ch.title, comic_id: ch.comic_id, comic_title: ch.comic_title },
      pages: pages.map((p) => ({ idx: p.idx, url: `/api/img/${p.r2_key}` })),
      nextChapterId: next?.id ?? null,
      prevChapterId: prev?.id ?? null,
    });
  }],

  // ===== 图片代理 =====
  ["GET", /^\/api\/img\/(.+)$/, async (c, env, m) => {
    const key = decodeURIComponent(m[1]);
    if (key.includes("..") || key.startsWith("/")) return err("图片不存在", 404);
    const obj = await env.BUCKET.get(key);
    if (!obj) return err("图片不存在", 404);
    const headers = {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=31536000, immutable",
    };
    if (obj.etag) headers["etag"] = obj.etag;
    return new Response(obj.body, { headers });
  }],

  // ===== 后台（需 ADMIN_TOKEN）=====
  ["POST", /^\/api\/comics$/, async (c, env) => {
    const g = await requireAdmin(c.req, env);
    if (g) return g;
    const body = await parseBody(c.req) || {};
    const title = String(body.title || "").trim();
    if (!title || title.length > 80) return err("标题需 1-80 字符");
    const { meta } = await env.DB.prepare(
      "INSERT INTO comics (title, author, category, description) VALUES (?, ?, ?, ?)")
      .bind(title,
        String(body.author || "").trim().slice(0, 40),
        String(body.category || "").trim().slice(0, 20) || "其他",
        String(body.description || "").slice(0, 2000)).run();
    return json({ id: meta.last_row_id }, 201);
  }],

  ["PUT", /^\/api\/comics\/(\d+)$/, async (c, env, m) => {
    const g = await requireAdmin(c.req, env);
    if (g) return g;
    const comic = await findComic(env, Number(m[1]));
    if (!comic) return err("漫画不存在", 404);
    const body = await parseBody(c.req) || {};
    const title = body.title !== undefined ? String(body.title).trim() : comic.title;
    if (!title || title.length > 80) return err("标题需 1-80 字符");
    await env.DB.prepare("UPDATE comics SET title=?, author=?, category=?, description=? WHERE id=?")
      .bind(title,
        body.author !== undefined ? String(body.author).trim().slice(0, 40) : comic.author,
        body.category !== undefined ? (String(body.category).trim().slice(0, 20) || "其他") : comic.category,
        body.description !== undefined ? String(body.description).slice(0, 2000) : comic.description,
        comic.id).run();
    return json({ ok: true });
  }],

  ["DELETE", /^\/api\/comics\/(\d+)$/, async (c, env, m) => {
    const g = await requireAdmin(c.req, env);
    if (g) return g;
    const comic = await findComic(env, Number(m[1]));
    if (!comic) return err("漫画不存在", 404);
    await deleteComicCascade(env, comic.id);
    return json({ ok: true });
  }],

  ["POST", /^\/api\/comics\/(\d+)\/cover$/, async (c, env, m) => {
    const g = await requireAdmin(c.req, env);
    if (g) return g;
    const comic = await findComic(env, Number(m[1]));
    if (!comic) return err("漫画不存在", 404);
    let form;
    try { form = await c.req.formData(); } catch { return err("multipart 解析失败"); }
    const { files, e } = await readImages({ getAll: (f) => form.getAll(f) }, env, "file");
    if (e) return e;
    const key = `c${comic.id}/cover/${Date.now()}-${randomHex(4)}`;
    await putImage(env, key, files[0]);
    await env.DB.prepare("UPDATE comics SET cover_key=? WHERE id=?").bind(key, comic.id).run();
    if (comic.cover_key) await env.BUCKET.delete(comic.cover_key);
    return json({ cover_key: key });
  }],

  ["POST", /^\/api\/comics\/(\d+)\/chapters$/, async (c, env, m) => {
    const g = await requireAdmin(c.req, env);
    if (g) return g;
    const comic = await findComic(env, Number(m[1]));
    if (!comic) return err("漫画不存在", 404);
    const body = await parseBody(c.req) || {};
    const { meta } = await env.DB.prepare(
      `INSERT INTO chapters (comic_id, num, title)
       VALUES (?, (SELECT COALESCE(MAX(num),0)+1 FROM chapters WHERE comic_id = ?), ?)`)
      .bind(comic.id, comic.id, String(body.title || "").slice(0, 80)).run();
    return json({ id: meta.last_row_id }, 201);
  }],

  ["DELETE", /^\/api\/chapters\/(\d+)$/, async (c, env, m) => {
    const g = await requireAdmin(c.req, env);
    if (g) return g;
    const ch = await findChapter(env, Number(m[1]));
    if (!ch) return err("章节不存在", 404);
    await deleteChapterCascade(env, ch.id);
    return json({ ok: true });
  }],

  ["POST", /^\/api\/chapters\/(\d+)\/pages$/, async (c, env, m) => {
    const g = await requireAdmin(c.req, env);
    if (g) return g;
    const ch = await findChapter(env, Number(m[1]));
    if (!ch) return err("章节不存在", 404);
    let form;
    try { form = await c.req.formData(); } catch { return err("multipart 解析失败"); }
    const { files, e } = await readImages(form, env);
    if (e) return e;
    const { mx } = await env.DB.prepare(
      "SELECT COALESCE(MAX(idx), -1) AS mx FROM pages WHERE chapter_id = ?").bind(ch.id).first();
    const added = [];
    for (const [i, f] of files.entries()) {
      const idx = mx + 1 + i;
      const ext = (f.name.split(".").pop() || "img").toLowerCase().slice(0, 8);
      const key = `c${ch.comic_id}/ch${ch.id}/p${idx}-${Date.now()}-${randomHex(4)}.${ext}`;
      await putImage(env, key, f);
      await env.DB.prepare("INSERT INTO pages (chapter_id, idx, r2_key) VALUES (?, ?, ?)")
        .bind(ch.id, idx, key).run();
      added.push({ idx, r2_key: key });
    }
    return json({ added: added.length, pages: added }, 201);
  }],
];

// ---------- fetch 入口 ----------

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    for (const [method, pattern, handler] of routes) {
      if (request.method !== method) continue;
      const m = path.match(pattern);
      if (!m) continue;
      try {
        return await handler({ req: request }, env, m);
      } catch (e) {
        console.error(`[api] ${method} ${path}`, e);
        return err("服务器内部错误", 500);
      }
    }
    return err("接口不存在", 404);
  },
};
