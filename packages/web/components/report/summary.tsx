import type { CSSProperties } from "react";
import type { Report } from "../../lib/report";
import { Slash } from "../brand/slash";
import { configLabels, splitName, summarize } from "./format";
import s from "./report.module.css";

function delay(step: number): CSSProperties {
  return { animationDelay: `${0.08 + step * 0.1}s` };
}

/*
 * The first screen of a report: the workload's name set like poster billing, a metadata row, and
 * one sentence that says what SERV changed, computed from the totals. The staggered entrance is CSS,
 * so it plays on first paint without waiting for any script.
 */
export function ReportSummary({ report }: { report: Report }) {
  const { title, deck } = splitName(report.name);
  const models = [...new Set(report.configs.map((c) => c.model))];
  const labels = configLabels(report.configs);
  const cases = report.cases.length;
  const size = title.length <= 30 ? "short" : title.length <= 60 ? "medium" : "long";
  const meta = [
    models.join(", "),
    `${cases} ${cases === 1 ? "case" : "cases"}`,
    labels.length === 1 ? labels[0]! : labels.join(" vs "),
  ];

  return (
    <section className={s.summary} aria-labelledby="report-title">
      <p className={`${s.marker} ${s.enter}`} style={delay(0)}>
        <Slash className={s.markerSlash} />
        <span>Urai report</span>
      </p>
      <p className={`${s.meta} ${s.enter}`} style={delay(1)}>
        {meta.map((item, i) => (
          <span key={i} className={s.metaItem}>
            {i > 0 && <Slash className={s.metaSlash} />}
            {item}
          </span>
        ))}
      </p>
      <h1 id="report-title" className={s.title} data-size={size}>
        <span className={s.titleLine}>
          <span className={s.rise} style={delay(1.5)}>
            {title}
          </span>
        </span>
      </h1>
      {deck !== null && (
        <p className={`${s.deck} ${s.enter}`} style={delay(2.5)}>
          {deck}
        </p>
      )}
      <p className={`${s.sentence} ${s.enter}`} style={delay(3.5)}>
        {summarize(report).map((part, i) =>
          part.strong ? (
            <strong key={i} className={s.sentenceNumber}>
              {part.text}
            </strong>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </p>
    </section>
  );
}
