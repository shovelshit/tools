-- Backfill only absent tolerance fields. Safe to run repeatedly on existing D1 databases.
-- Preserve explicit 0/30/180, null and invalid values, all other fields and timestamps.
UPDATE lock_rule
SET data = json_set(data, '$.timeToleranceMinutes', 30)
WHERE json_type(data) = 'object'
  AND json_type(data, '$.timeToleranceMinutes') IS NULL;
