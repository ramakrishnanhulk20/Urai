import type { ConfigTotals, Report } from "../../lib/report";
import { configLabels, count, percentNumber, seconds, usd } from "./format";
import { CountUp, Reveal, RevealItem, RubBar } from "./motion";
import { SectionHead } from "./parts";
import s from "./report.module.css";

const OTHER_STATUS_WORDS: Record<string, string> = {
  failed: "failed",
  refused: "refused",
  filtered: "filtered",
  timeout: "timed out",
  upstream_error: "with no response",
};

/* The answers that never got scored, named, so "wrong" is never mistaken for "the model disagreed". */
function unscored(totals: ConfigTotals): string[] {
  return Object.entries(totals.statusCounts)
    .filter(([status, n]) => status !== "scored" && n > 0)
    .map(([status, n]) => `${n} ${OTHER_STATUS_WORDS[status] ?? status}`);
}

function balanceLine(balance: NonNullable<Report["balance"]>): string {
  const { before, after } = balance;
  const spent = before !== null && after !== null ? `, ${usd(Math.max(0, before - after))} spent in total` : "";
  return `Measured on the SERV key's balance: ${usd(before)} before the run, ${usd(after)} after${spent}. The per-setting costs above are estimates from token prices.`;
}

/**
 * Accuracy per setting as a hallmark number stamped beside a gold bar, with right and wrong
 * counts, speed, tokens and estimated cost. Every figure comes from report.totals; a total that
 * is not known reads "unknown", never zero.
 */
export function Verdict({ report }: { report: Report }) {
  const labels = configLabels(report.configs);
  const known = report.totals.map((t) => t.accuracy).filter((a): a is number => a !== null);
  // Only a real lead earns the gold: with one setting, or a tie across all of them, nothing is marked.
  const best = known.length > 1 && new Set(known).size > 1 ? Math.max(...known) : null;

  return (
    <section className={s.section} aria-labelledby="verdict-title">
      <SectionHead index="The verdict" title="What SERV changed" id="verdict-title">
        <p>
          Accuracy is the share of cases answered right. An answer that failed, was refused, filtered or never came
          back counts as wrong.
        </p>
      </SectionHead>

      <Reveal className={s.verdictRows} stagger={0.14}>
        {report.configs.map((config, i) => {
          const t = report.totals[i];
          const accuracy = t?.accuracy ?? null;
          const other = t === undefined ? [] : unscored(t);
          return (
            <RevealItem as="article" key={i} className={s.vRow}>
              <header className={s.vLabel}>
                <h3 className={s.vName}>{labels[i]}</h3>
                <span className={s.vModel}>{config.model}</span>
              </header>

              <div className={s.vBar}>
                <span className={s.vTrack} aria-hidden="true">
                  {accuracy !== null && <RubBar accuracy={accuracy} className={s.vFill} />}
                </span>
                <p className={s.vNumber} data-unknown={accuracy === null} data-best={best !== null && accuracy === best}>
                  {accuracy === null ? (
                    "unknown"
                  ) : (
                    <>
                      <CountUp value={accuracy * 100} text={percentNumber(accuracy)} />
                      <span className={s.pctSign}>%</span>
                    </>
                  )}
                </p>
              </div>

              <p className={s.vCounts}>
                {t === undefined || t.calls === 0 ? (
                  <span className={s.wrongText}>No finished answers yet</span>
                ) : (
                  <>
                    <span className={s.rightText}>
                      {t.correct} of {t.calls} right
                    </span>
                    <span className={s.wrongText}>{t.calls - t.correct} wrong</span>
                    {other.length > 0 && <span className={s.wrongText}>of which {other.join(", ")}</span>}
                  </>
                )}
              </p>

              <dl className={s.vStats}>
                <div>
                  <dt>Mean latency</dt>
                  <dd>{seconds(t?.meanLatencyMs ?? null)}</dd>
                </div>
                <div>
                  <dt>Input tokens</dt>
                  <dd>{count(t?.inputTokens ?? null)}</dd>
                </div>
                <div>
                  <dt>Output tokens</dt>
                  <dd>{count(t?.outputTokens ?? null)}</dd>
                </div>
                <div>
                  <dt>Estimated cost</dt>
                  <dd>{usd(t?.estCostUsd ?? null)}</dd>
                </div>
              </dl>
            </RevealItem>
          );
        })}
      </Reveal>

      {report.balance !== null && <p className={s.balance}>{balanceLine(report.balance)}</p>}
    </section>
  );
}
