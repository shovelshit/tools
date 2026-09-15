-- ============ tools-api D1 schema(用户状态全链路存储) ============
-- 适用: Cloudflare D1(SQLite)。KV 仅保留 maoyan-session 加密会话与 cache:cinemas:* 影院缓存。
-- 建库: wrangler d1 create tools-db
-- 建表: wrangler d1 execute tools-db --remote --file schema.sql
-- 说明: config/status/lock-rule 按令牌一行(JSON blob), snapshot 按 (token_id, movie_id) 一行,
--       change_log 追加式全量历史(读取时 LIMIT 100 与旧 KV 上限语义一致), seatfb 用原 KV key 作主键。

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS user_config (
  token_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_status (
  token_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_snapshot (
  token_id TEXT NOT NULL,
  movie_id TEXT NOT NULL,
  seq_nos TEXT NOT NULL,            -- JSON 数组: ["seqNo", ...]
  updated_at TEXT NOT NULL,
  PRIMARY KEY (token_id, movie_id)
);

CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  time TEXT NOT NULL,
  type TEXT,
  text TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_log_token ON change_log (token_id, id DESC);

CREATE TABLE IF NOT EXISTS seat_feedback (
  fb_key TEXT PRIMARY KEY,          -- 原 KV key: seatfb:{cinemaId}:{seqNo||"na"}
  reported_at TEXT NOT NULL,
  day TEXT,
  token_id TEXT,
  cinema_id TEXT,
  movie_id TEXT,
  seq_no TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS lock_rule (
  token_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,               -- JSON: 规则状态机全文
  updated_at TEXT NOT NULL
);
