-- Server-wide stops that outlive any one run. A row present means the flag is set; the operator
-- clears it by hand (see lib/flags.ts), never the app.
CREATE TABLE app_flags (
  name text PRIMARY KEY,
  set_at timestamptz NOT NULL DEFAULT now(),
  detail text NULL
);

-- C28: the operator balance at the day's first reading, the day's settled demo calls, and the
-- stop that holds once the realised drop passes the cap.
ALTER TABLE demo_budget
  ADD COLUMN balance_start_usd numeric(10,4) NULL,
  ADD COLUMN calls int NOT NULL DEFAULT 0,
  ADD COLUMN stopped boolean NOT NULL DEFAULT false;
