ALTER TABLE pending_session_saves
  ADD COLUMN reservation_count INTEGER NOT NULL DEFAULT 1 CHECK (reservation_count > 0);
