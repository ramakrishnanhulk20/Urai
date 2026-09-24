import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseWorkload, type RunConfig } from "@urai/engine";
import { db, toJsonb } from "../lib/db";
import { hashToken, newOwnerToken } from "../lib/ids";
import { loadRootEnv } from "../lib/root-env";

// Sample ids are public by design: anyone may start a demo run on them.
const SAMPLES = [
  { id: "sample-invoices-good", file: "invoices-good.json" },
  { id: "sample-invoices-bad", file: "invoices-bad.json" },
  { id: "sample-invoices-hard", file: "invoices-hard.json" },
] as const;

// The only settings the operator's key will pay for on a sample (C4): the cheap model, SERV off and plain.
const SAMPLE_CONFIGS: RunConfig[] = [
  { model: "gpt-6-luna", mode: "raw" },
  { model: "gpt-6-luna", mode: "plain" },
];

const SAMPLE_EXPIRES_AT = "2100-01-01T00:00:00Z";

/*
 * Inserts the three invoice samples, or updates one whose file or allowed settings changed.
 * An unchanged sample is left alone, so a second run writes nothing. Each file goes through
 * parseWorkload exactly like a team's upload. The owner hash is of a token that is thrown
 * away at once: nobody can start a team run on a sample or claim to own it.
 */
async function main(): Promise<void> {
  loadRootEnv();
  const sql = db();
  const configs = toJsonb(SAMPLE_CONFIGS);
  if (configs === null) throw new Error("sample configs are not storable");

  for (const s of SAMPLES) {
    const path = fileURLToPath(new URL(`../../engine/workloads/${s.file}`, import.meta.url));
    const parsed = parseWorkload(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.ok) throw new Error(`${s.file} does not parse: ${parsed.errors.slice(0, 3).join("; ")}`);
    const data = toJsonb(parsed.workload);
    if (data === null) throw new Error(`${s.file} is not storable`);

    const rows = await sql`
      INSERT INTO workloads (id, owner_hash, is_sample, sample_configs, data, expires_at)
      VALUES (${s.id}, ${hashToken(newOwnerToken())}, true, ${configs}::jsonb, ${data}::jsonb, ${SAMPLE_EXPIRES_AT})
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, sample_configs = EXCLUDED.sample_configs
        WHERE workloads.is_sample
          AND (workloads.data IS DISTINCT FROM EXCLUDED.data OR workloads.sample_configs IS DISTINCT FROM EXCLUDED.sample_configs)
      RETURNING (xmax = 0) AS inserted`;
    const row = rows[0];
    console.log(`${s.id}: ${row === undefined ? "unchanged" : row.inserted ? "inserted" : "updated"} (${parsed.workload.cases.length} cases)`);
  }
}

main().catch((err: unknown) => {
  console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
