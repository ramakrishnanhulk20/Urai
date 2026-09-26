-- The one delete the case route makes, handing back a claim that never spent anything, moves into
-- a function owned by this migration's login. The app's login (urai_app, C35) then needs no DELETE
-- on case_results at all, so it can never remove a stored answer, only an unfinished claim whose
-- exact claimed_at mark it already holds.

/*
 * Deletes the claim for (run, case, setting) only while it is unfinished and still carries the
 * mark the caller's claim returned, the same rows lib/claim.ts releaseClaim deleted before this
 * migration. A claim another request took over has a new mark and is left alone. Returns true when
 * a row was deleted. The table is named with its schema, so a temporary table of the same name
 * can never stand in for it.
 */
CREATE FUNCTION urai_release_claim(p_run_id text, p_case_id text, p_config_idx int, p_mark numeric) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted int;
BEGIN
  DELETE FROM public.case_results
  WHERE run_id = p_run_id AND case_id = p_case_id AND config_idx = p_config_idx
    AND finished_at IS NULL AND extract(epoch FROM claimed_at) = p_mark;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted > 0;
END
$$;

-- Postgres lets every role run a new function; only the app's login may run this one.
REVOKE ALL ON FUNCTION urai_release_claim(text, text, int, numeric) FROM PUBLIC;

-- A database where create-app-role has not run yet has no urai_app; create-app-role grants it then.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urai_app') THEN
    GRANT EXECUTE ON FUNCTION urai_release_claim(text, text, int, numeric) TO urai_app;
  END IF;
END
$$;
