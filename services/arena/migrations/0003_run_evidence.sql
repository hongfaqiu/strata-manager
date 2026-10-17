-- Benchmark Arena schema v3: signed in-app run evidence. A run whose evidence passes the consistency checks is
-- 'verified' and counts immediately; 'missing' or 'failed' evidence leaves it pending.
ALTER TABLE submissions ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'missing'; -- verified | failed | missing
ALTER TABLE submissions ADD COLUMN evidence_reason TEXT;   -- first failing checks, comma-separated
ALTER TABLE submissions ADD COLUMN evidence_json TEXT;     -- the exact signed evidence text (content-free trace)
ALTER TABLE submissions ADD COLUMN evidence_sig TEXT;      -- Ed25519 signature by the install key over its digest
ALTER TABLE installs ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
UPDATE installs SET status = 'pending' WHERE status = 'probation';
