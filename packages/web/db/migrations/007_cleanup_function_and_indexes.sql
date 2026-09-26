-- The daily clean-up moves into functions owned by this migration's login, so the app's login
-- (urai_app, C35) needs no DELETE on workloads, runs, demo_budget or rate_limits: it can run the
-- fixed retention rules and nothing else. The functions take no arguments, so no caller can widen
-- what they delete.

-- The sample reports the landing page links to. Their runs' workloads are never touched by the
-- demo run rule. Only the owner login writes this table; the cron route refuses to clean up while
-- any report in lib/sample-reports.json is missing from it, so the two can only drift toward
-- keeping more.
CREATE TABLE kept_reports (
  report_id text PRIMARY KEY
);
INSERT INTO kept_reports (report_id) VALUES
  ('2SC_jtj9dqui6VGFIrQQ0A'),
  ('uVNL7475vDXOlUTxxCOVNA'),
  ('l9eNk-PBGlRDmUnNIxzsxQ'),
  ('zTS-p-PZ_w8nRzVCCgHk1g');

-- The retention numbers urai_cleanup() uses, named as in lib/config.ts. The cron route only runs
-- the clean-up when these equal its CONFIG values, so a changed config never deletes by old rules.
CREATE FUNCTION urai_retention() RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'demoRunRetentionDays', 7,
    'unrunWorkloadRetentionHours', 48,
    'rateLimitRetentionDays', 2,
    'demoBudgetRetentionDays', 30)
$$;

/*
 * The same deletes, in the same order, that GET /api/cron/cleanup ran as one transaction before
 * this migration. now() is the transaction's start time, so every rule shares one cut-off. Tables
 * are named with their schema, so a temporary table of the same name can never stand in for one.
 */
CREATE FUNCTION urai_cleanup() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  demo_case_results int;
  demo_runs int;
  case_results_n int;
  runs_n int;
  workloads_n int;
  unrun_workloads int;
  rate_limits_n int;
  budget_days int;
BEGIN
  DELETE FROM public.case_results WHERE run_id IN (
    SELECT id FROM public.runs
    WHERE payer = 'demo' AND created_at < now() - make_interval(days => 7)
      AND workload_id NOT IN (
        SELECT workload_id FROM public.runs WHERE report_id IN (SELECT report_id FROM public.kept_reports)));
  GET DIAGNOSTICS demo_case_results = ROW_COUNT;

  DELETE FROM public.runs
  WHERE payer = 'demo' AND created_at < now() - make_interval(days => 7)
    AND workload_id NOT IN (
      SELECT workload_id FROM public.runs WHERE report_id IN (SELECT report_id FROM public.kept_reports));
  GET DIAGNOSTICS demo_runs = ROW_COUNT;

  DELETE FROM public.case_results WHERE run_id IN (
    SELECT r.id FROM public.runs r JOIN public.workloads w ON w.id = r.workload_id
    WHERE w.expires_at <= now() AND NOT w.is_sample);
  GET DIAGNOSTICS case_results_n = ROW_COUNT;

  DELETE FROM public.runs WHERE workload_id IN (
    SELECT id FROM public.workloads WHERE expires_at <= now() AND NOT is_sample);
  GET DIAGNOSTICS runs_n = ROW_COUNT;

  DELETE FROM public.workloads WHERE expires_at <= now() AND NOT is_sample;
  GET DIAGNOSTICS workloads_n = ROW_COUNT;

  DELETE FROM public.workloads w
  WHERE NOT w.is_sample
    AND w.created_at < now() - make_interval(hours => 48)
    AND NOT EXISTS (SELECT 1 FROM public.runs r WHERE r.workload_id = w.id);
  GET DIAGNOSTICS unrun_workloads = ROW_COUNT;

  DELETE FROM public.rate_limits WHERE window_start < now() - make_interval(days => 2);
  GET DIAGNOSTICS rate_limits_n = ROW_COUNT;

  -- The budget day is the UTC date (lib/budget.ts budgetDay), so the cut-off is counted in UTC too.
  DELETE FROM public.demo_budget WHERE day < (now() AT TIME ZONE 'UTC')::date - 30;
  GET DIAGNOSTICS budget_days = ROW_COUNT;

  RETURN jsonb_build_object(
    'workloads', workloads_n,
    'runs', runs_n,
    'caseResults', case_results_n,
    'demoRuns', demo_runs,
    'demoCaseResults', demo_case_results,
    'unrunWorkloads', unrun_workloads,
    'rateLimits', rate_limits_n,
    'budgetDays', budget_days);
END
$$;

-- Postgres lets every role run a new function; only the logins create-app-role names may.
REVOKE ALL ON FUNCTION urai_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION urai_retention() FROM PUBLIC;

-- The clean-up's date filters, the per-run lookups the demo and expiry rules join on, and the
-- storage cap's sum over unexpired team workloads.
CREATE INDEX workloads_created_at_idx ON workloads (created_at);
CREATE INDEX workloads_expires_at_idx ON workloads (expires_at);
CREATE INDEX runs_workload_id_idx ON runs (workload_id);
CREATE INDEX runs_created_at_idx ON runs (created_at);
CREATE INDEX rate_limits_window_start_idx ON rate_limits (window_start);
