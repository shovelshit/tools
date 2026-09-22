-- Run once against existing deployments before enabling feedback status updates.
ALTER TABLE seat_feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'unprocessed';
