-- Balance readings come from the probe (C7, C19): null means no reading, never zero.
ALTER TABLE runs ADD COLUMN balance_before numeric NULL;
ALTER TABLE runs ADD COLUMN balance_after numeric NULL;
ALTER TABLE runs ADD COLUMN probes int NOT NULL DEFAULT 0;
-- The case ids this run may call (C10). Runs created before this migration keep null and are refused.
ALTER TABLE runs ADD COLUMN case_ids jsonb NULL;

ALTER TABLE case_results ADD COLUMN est_cost_usd numeric NULL;
