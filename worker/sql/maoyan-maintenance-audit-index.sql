CREATE INDEX IF NOT EXISTS idx_audit_events_type_request
ON audit_events(event_type, request_id, id DESC);
