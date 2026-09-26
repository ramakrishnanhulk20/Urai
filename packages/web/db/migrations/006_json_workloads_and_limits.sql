-- jsonb sorts object keys (shorter keys first), which reordered every answer schema before it
-- reached SERV, and field order changes what a model writes first. json keeps the text exactly as
-- sent. Rows stored before this keep jsonb's order; the seed script rewrites the samples.
ALTER TABLE workloads ALTER COLUMN data TYPE json USING data::json;

-- The stored size of each workload, so the storage cap sums one small column instead of measuring
-- every document. No default: an insert that forgets it fails instead of counting as zero.
ALTER TABLE workloads ADD COLUMN size_bytes integer NULL;
UPDATE workloads SET size_bytes = octet_length(data::text);
ALTER TABLE workloads ALTER COLUMN size_bytes SET NOT NULL;
ALTER TABLE workloads ADD CONSTRAINT workloads_size_bytes_nonnegative CHECK (size_bytes >= 0);

-- Only one server instance refreshes the SERV model list at a time; the lease lapses on its own
-- if that instance dies mid-refresh.
ALTER TABLE model_cache ADD COLUMN refresh_lease_until timestamptz NULL;

-- A last line behind DEMO_DAILY_BUDGET_USD: a mistyped budget cannot open the operator key wide.
ALTER TABLE demo_budget ADD CONSTRAINT demo_budget_cap_at_most_10 CHECK (cap_usd <= 10);
