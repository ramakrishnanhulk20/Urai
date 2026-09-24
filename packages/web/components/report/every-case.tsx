import type { CSSProperties } from "react";
import type { Report } from "../../lib/report";
import { clip, configLabels, expectedText, statusView } from "./format";
import { Reveal, RevealItem } from "./motion";
import { AnswerFull, ExpectedList, SectionHead } from "./parts";
import s from "./report.module.css";

/*
 * Every case against every setting, one row each, with a status dot per setting. A row opens to
 * show the whole input, the expected answer and every answer in full. Rows are native
 * details elements, so they open with no script and a keyboard works them out of the box. On a
 * phone the columns fold into a list where each dot carries its setting's name.
 */
export function EveryCase({ report }: { report: Report }) {
  const labels = configLabels(report.configs);
  const disagree = new Set(report.disagreements);
  const grid = { "--n": report.configs.length } as CSSProperties;

  return (
    <section className={s.section} aria-labelledby="cases-title">
      <SectionHead index="The record" title="Every case" id="cases-title">
        <p>
          {report.cases.length} {report.cases.length === 1 ? "case" : "cases"} across {labels.length}{" "}
          {labels.length === 1 ? "setting" : "settings"}. Open any row to read the input and every answer in full.
        </p>
      </SectionHead>

      <Reveal className={s.table} amount={0.02}>
        <RevealItem className={`${s.tRow} ${s.tHead}`} style={grid}>
          <span>Case</span>
          {labels.map((label, i) => (
            <span key={i}>{label}</span>
          ))}
          <span>Expected</span>
          <span />
        </RevealItem>

        <RevealItem>
          {report.cases.map((c) => (
            <details key={c.id} className={s.tCase}>
              <summary className={s.tRow} style={grid}>
                <span className={s.tId}>
                  {c.id}
                  {disagree.has(c.id) && <span className={s.tFlag}>Split</span>}
                </span>
                {c.results.map((result, i) => {
                  const view = statusView(result);
                  return (
                    <span key={i} className={s.tCell} data-tone={view.tone}>
                      <span className={s.dot} data-tone={view.tone} aria-hidden="true" />
                      <span className={s.tCellLabel}>{labels[i]}: </span>
                      <span className={s.tCellWord}>{view.word}</span>
                    </span>
                  );
                })}
                <span className={s.tExpected}>
                  {clip(
                    Object.entries(c.expected)
                      .map(([k, v]) => `${k}: ${expectedText(v)}`)
                      .join("; "),
                    70,
                  )}
                </span>
                <span className={s.chevron} aria-hidden="true" />
              </summary>

              <div className={s.tBody}>
                <div className={s.tInput}>
                  <p className={s.smallLabel}>Input</p>
                  <pre className={s.pre} data-lenis-prevent>
                    {c.input}
                  </pre>
                </div>
                <div className={s.tAnswers}>
                  <div className={s.tAnswer}>
                    <p className={s.smallLabel}>Expected</p>
                    <ExpectedList expected={c.expected} max={2000} />
                  </div>
                  {c.results.map((result, i) => (
                    <div key={i} className={s.tAnswer} data-tone={statusView(result).tone}>
                      <p className={s.smallLabel}>
                        {labels[i]} <span className={s.tAnswerWord}>{statusView(result).word}</span>
                      </p>
                      <AnswerFull result={result} />
                    </div>
                  ))}
                </div>
              </div>
            </details>
          ))}
        </RevealItem>
      </Reveal>
    </section>
  );
}
