CREATE TABLE IF NOT EXISTS maoyan_business_policy (
  id INTEGER PRIMARY KEY CHECK (id=1),
  monitor_start_minute INTEGER NOT NULL CHECK (monitor_start_minute BETWEEN 0 AND 1439),
  monitor_end_minute INTEGER NOT NULL CHECK (monitor_end_minute BETWEEN 0 AND 1439),
  maintenance_start_minute INTEGER NOT NULL CHECK (maintenance_start_minute BETWEEN 0 AND 1439),
  maintenance_end_minute INTEGER NOT NULL CHECK (maintenance_end_minute BETWEEN 1 AND 1439),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO maoyan_business_policy
  (id,monitor_start_minute,monitor_end_minute,maintenance_start_minute,maintenance_end_minute,version,updated_at)
VALUES (1,420,1380,60,120,1,0);
