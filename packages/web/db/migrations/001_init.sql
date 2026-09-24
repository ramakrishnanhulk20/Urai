CREATE TABLE workloads (
  id text PRIMARY KEY,
  owner_hash text NOT NULL,
  is_sample boolean NOT NULL DEFAULT false,
  sample_configs jsonb NULL,
  data jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE runs (
  id text PRIMARY KEY,
  workload_id text NOT NULL REFERENCES workloads(id),
  report_id text UNIQUE NOT NULL,
  owner_hash text NOT NULL,
  payer text NOT NULL CHECK (payer IN ('team', 'demo')),
  configs jsonb NOT NULL,
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  flagged text NULL
);

CREATE TABLE case_results (
  run_id text REFERENCES runs(id),
  case_id text,
  config_idx int,
  status text NOT NULL,
  result jsonb NULL,
  claimed_at timestamptz DEFAULT now(),
  finished_at timestamptz NULL,
  PRIMARY KEY (run_id, case_id, config_idx)
);

CREATE TABLE demo_budget (
  day date PRIMARY KEY,
  reserved_usd numeric(10,4) NOT NULL DEFAULT 0,
  spent_usd numeric(10,4) NOT NULL DEFAULT 0,
  cap_usd numeric(10,4) NOT NULL
);

CREATE TABLE rate_limits (
  bucket text,
  window_start timestamptz,
  count int NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
