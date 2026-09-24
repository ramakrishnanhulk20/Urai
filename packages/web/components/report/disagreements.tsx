import type { CSSProperties } from "react";
import type { Report } from "../../lib/report";
import { clip, configLabels, statusView } from "./format";
import { Reveal, RevealItem } from "./motion";
import { AnswerBrief, ExpectedList, SectionHead, StatusMark } from "./parts";
import s from "./report.module.css";

const INPUT_EXCERPT_CHARS = 420;

/**
 * Every case in report.disagreements: the cases where one setting was right and another was
 * wrong. Each shows the expected answer, the start of the input, and what every setting said.
 * Renders nothing for a run of one setting, where there is no second answer to disagree with.
 */
export function Disagreements({ report }: { report: Report }) {
  const labels = configLabels(report.configs);
  const wanted = new Set(report.disagreements);
  const cases = report.cases.filter((c) => wanted.has(c.id));
  const total = report.cases.length;
  if (report.configs.length < 2) return null;

  let lede: string;
  if (cases.length === 0) lede = `Every setting got the same cases right and the same cases wrong, across all ${total}.`;
  else
    lede = `In ${cases.length} of ${total} ${total === 1 ? "case" : "cases"}, one setting was right and another was wrong. These are the answers that decide whether SERV helps this agent.`;

  return (
    <section className={s.section} aria-labelledby="disagreements-title">
      <SectionHead index="Side by side" title="Where they disagreed" id="disagreements-title">
        <p>{lede}</p>
      </SectionHead>

      {cases.length > 0 && (
        <Reveal as="ol" className={s.dList} stagger={0.06} amount={0.02}>
          {cases.map((c) => {
            const keys = Object.keys(c.expected);
            return (
              <RevealItem as="li" key={c.id} className={s.dCase}>
                <div className={s.dMeta}>
                  <p className={s.caseId}>{c.id}</p>
                  <div className={s.dExpected}>
                    <p className={s.smallLabel}>Expected</p>
                    <ExpectedList expected={c.expected} />
                  </div>
                  <p className={s.smallLabel}>Input</p>
                  <p className={s.excerpt}>{clip(c.input, INPUT_EXCERPT_CHARS)}</p>
                </div>
                <div className={s.dAnswers} style={{ "--n": Math.min(report.configs.length, 3) } as CSSProperties}>
                  {c.results.map((result, i) => (
                    <div key={i} className={s.dAnswer} data-tone={statusView(result).tone}>
                      <div className={s.dAnswerHead}>
                        <p className={s.dConfig}>{labels[i]}</p>
                        <StatusMark result={result} />
                      </div>
                      <AnswerBrief result={result} keys={keys} />
                    </div>
                  ))}
                </div>
              </RevealItem>
            );
          })}
        </Reveal>
      )}
    </section>
  );
}
