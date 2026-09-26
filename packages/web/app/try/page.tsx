import type { Metadata } from "next";
import { connection } from "next/server";
import { Slash } from "../../components/brand/slash";
import { Stone } from "../../components/brand/stone";
import { Footer } from "../../components/site/footer";
import { Header } from "../../components/site/header";
import { SmoothScroll } from "../../components/smooth-scroll";
import { PickJump } from "../../components/try/pick-jump";
import { TryDemo } from "../../components/try/try-demo";
import s from "../../components/try/try.module.css";
import { configLabels, modeNote, type DemoConfig, type SampleChoice, type SavedResult } from "../../components/try/types";
import { CONFIG } from "../../lib/config";
import { db } from "../../lib/db";
import { loadWorkload } from "../../lib/report";
import { canonicalConfigs } from "../../lib/run-config";
import { cachedSample, getSample } from "../../lib/samples";

export const metadata: Metadata = {
  title: "Live demo",
  description: "Pick a sample agent and watch Urai run it live, SERV off and SERV on, with no key needed.",
};

/*
 * The three operator samples, in the order the story reads: the setup mistake, the same agent
 * set up right, then the hard rulebook. savedSlug points at the saved full run of the same
 * workload file in lib/sample-reports.json.
 */
const SAMPLES = [
  {
    workloadId: "sample-invoices-bad",
    savedSlug: "fix-before",
    name: "Data in the wrong place",
    line: "The payables agent with its whole supplier book pasted into the system prompt: the layout mistake Urai flags and fixes in one click.",
  },
  {
    workloadId: "sample-invoices-good",
    savedSlug: "parity",
    name: "The same agent, set up right",
    line: "Rules in the system prompt, supplier data in the user message. The fair test of what SERV changes.",
  },
  {
    workloadId: "sample-invoices-hard",
    savedSlug: "hard",
    name: "The 152-rule hard rulebook",
    line: "152 clauses from four layered rule sources, the kind of policy where one missed exception flips a payment.",
  },
] as const;

function logFailure(what: string, err: unknown): void {
  console.error(`[urai] /try: ${what} failed (${err instanceof Error ? err.name : "error"})`);
}

/*
 * The settings the sample allows for a demo run, from the same allowlist POST /api/runs checks (C4).
 * Cached for a minute like the rest of the sample reads (C31); POST /api/runs still reads it live.
 */
function allowedConfigs(workloadId: string): Promise<DemoConfig[]> {
  return cachedSample(`configs:${workloadId}`, async () => {
    const rows = await db()`
      SELECT sample_configs FROM workloads
      WHERE id = ${workloadId} AND is_sample = true AND expires_at > now()`;
    return canonicalConfigs(rows[0]?.sample_configs) ?? [];
  });
}

function expectedVerdict(expected: Record<string, unknown>): string | null {
  const verdict = expected.verdict;
  return typeof verdict === "string" ? verdict : null;
}

async function expectedFor(workloadId: string): Promise<Record<string, string>> {
  const workload = await cachedSample(`workload:${workloadId}`, () => loadWorkload(workloadId));
  const out: Record<string, string> = {};
  for (const c of workload.cases.slice(0, CONFIG.demoCasesMax)) {
    const v = expectedVerdict(c.expected);
    if (v !== null) out[c.id] = v;
  }
  return out;
}

async function savedFor(slug: string): Promise<SavedResult | null> {
  const sample = await getSample(slug);
  if (sample === null) return null;
  const labels = configLabels(sample.report.configs);
  const columns = sample.report.configs.flatMap((_, k) => {
    const t = sample.report.totals[k];
    return t === undefined || t.accuracy === null
      ? []
      : [{ label: labels[k]!, accuracy: t.accuracy, correct: t.correct, calls: t.calls }];
  });
  if (columns.length === 0) return null;
  return { reportId: sample.reportId, title: sample.title, cases: sample.report.cases.length, columns };
}

/*
 * Each part is loaded on its own, so one missing saved report or one unreadable sample greys out
 * that piece instead of taking the whole page down.
 */
async function loadChoice(entry: (typeof SAMPLES)[number]): Promise<SampleChoice> {
  const [configs, expected, saved] = await Promise.all([
    allowedConfigs(entry.workloadId).catch((err: unknown) => {
      logFailure(`allowlist for ${entry.workloadId}`, err);
      return [];
    }),
    expectedFor(entry.workloadId).catch((err: unknown) => {
      logFailure(`cases for ${entry.workloadId}`, err);
      return {};
    }),
    savedFor(entry.savedSlug).catch((err: unknown) => {
      logFailure(`saved report ${entry.savedSlug}`, err);
      return null;
    }),
  ]);
  return { workloadId: entry.workloadId, name: entry.name, line: entry.line, configs, expected, saved };
}

export default async function TryPage() {
  // Everything here is read from the database on each request, never frozen into the build.
  await connection();
  const samples = await Promise.all(SAMPLES.map(loadChoice));

  const all = samples.flatMap((x) => x.configs);
  const labels = [...new Set(configLabels(all))];
  const note = modeNote(all);
  const models = [...new Set(all.map((c) => c.model))];
  const meta = [`${CONFIG.demoCasesMax} real cases`, labels.join(" and "), ...models].filter((m) => m !== "");

  return (
    <>
      <SmoothScroll />
      <Stone streak={false} />
      <Header />
      <main className={s.root}>
        <section className={s.intro} aria-labelledby="try-title">
          <p className={`${s.meta} ${s.enter}`} style={{ animationDelay: "0.05s" }}>
            <span className={`${s.metaItem} ${s.live}`}>
              <span className={s.liveDot} aria-hidden="true" />
              Live demo
            </span>
            {meta.map((item) => (
              <span key={item} className={s.metaItem}>
                <Slash className={s.metaSlash} />
                {item}
              </span>
            ))}
          </p>
          <h1 id="try-title" className={s.headline} aria-label="Run it live. No key needed.">
            <span className={s.line}>
              <span className={s.rise} style={{ animationDelay: "0.1s" }}>
                Run it <em className={s.goldWord}>live.</em>
              </span>
            </span>
            <span className={s.line}>
              <span className={s.rise} style={{ animationDelay: "0.22s" }}>
                No key needed.
              </span>
            </span>
          </h1>
          <div className={s.ledeRow}>
            <p className={`${s.lede} ${s.enter}`} style={{ animationDelay: "0.42s" }}>
              Pick a sample agent. Urai runs {CONFIG.demoCasesMax} of its real cases with{" "}
              <strong>{labels.join(" and ")}</strong>, and you watch every answer come back as the model gives it.
              {note !== null && ` ${note}`}
            </p>
            <PickJump style={{ animationDelay: "0.55s" }} />
          </div>
        </section>

        <TryDemo samples={samples} cases={CONFIG.demoCasesMax} />
        <div className={s.tail} />
      </main>
      <Footer />
    </>
  );
}
