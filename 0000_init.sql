-- 0000_init
CREATE TABLE comics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '其他',
  description TEXT NOT NULL DEFAULT '',
  cover_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comic_id INTEGER NOT NULL,
  num INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT ''
);

CREATE TABLE pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  r2_key TEXT NOT NULL
);

CREATE INDEX idx_chapters_comic ON chapters(comic_id, num);
CREATE INDEX idx_pages_chapter ON pages(chapter_id, idx);
CREATE INDEX idx_comics_cat ON comics(category, id);
