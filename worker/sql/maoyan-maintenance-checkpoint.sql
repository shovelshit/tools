CREATE TABLE IF NOT EXISTS maoyan_maintenance_runs (
  job_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  cursor TEXT,
  lease_until INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, local_date)
);
