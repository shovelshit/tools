CREATE TABLE IF NOT EXISTS pending_session_saves (
  user_id TEXT NOT NULL REFERENCES users(id),
  session_key TEXT NOT NULL,
  PRIMARY KEY (user_id, session_key)
);
