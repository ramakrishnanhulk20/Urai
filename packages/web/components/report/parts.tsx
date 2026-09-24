import type { ExpectedValue } from "@urai/engine";
import type { ReactNode } from "react";
import type { ReportCaseResult } from "../../lib/report";
import { Slash } from "../brand/slash";
import { clip, expectedText, seconds, statusView, valueText } from "./format";
import s from "./report.module.css";

/*
 * Every string in this file that came from a team, a model or the lint is placed as a React text
 * child, which React escapes. Nothing here, or anywhere in the report tree, sets inner HTML or runs
 * text through a markdown renderer (threat model C20).
 */

export function SectionHead({ index, title, id, children }: { index: string; title: string; id: string; children?: ReactNode }) {
  return (
    <header className={s.sectionHead}>
      <p className={s.marker}>
        <Slash className={s.markerSlash} />
        <span>{index}</span>
      </p>
      <h2 id={id} className={s.sectionTitle}>
        {title}
      </h2>
      {children !== undefined && <div className={s.sectionLede}>{children}</div>}
    </header>
  );
}

export function StatusMark({ result }: { result: ReportCaseResult | null }) {
  const view = statusView(result);
  return (
    <span className={s.status} data-tone={view.tone}>
      <span className={s.dot} data-tone={view.tone} aria-hidden="true" />
      {view.word}
    </span>
  );
}

export function ExpectedList({ expected, max = 160 }: { expected: Record<string, ExpectedValue>; max?: number }) {
  return (
    <dl className={s.fields}>
      {Object.entries(expected).map(([key, value]) => (
        <div key={key} className={s.field}>
          <dt>{key}</dt>
          <dd>{clip(expectedText(value), max)}</dd>
        </div>
      ))}
    </dl>
  );
}

/*
 * The mark on anything the report shortened. A prompt keeps its start, so it says where the cut
 * fell; an answer over the cap is dropped whole, so it says how long it was.
 */
export function CutLabel({ kept, total }: { kept: number | null; total: number }) {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <p className={s.cut}>
      {kept !== null
        ? `Cut at ${n(kept)} characters, of ${n(total)}`
        : `Answer cut: it ran to ${n(total)} characters, over the report's limit`}
    </p>
  );
}

/*
 * One answer, short: the fields the case is scored on, then the model's reason when it gave one.
 * An answer too long to keep says where it was cut; a reply that never parsed shows as raw text.
 */
export function AnswerBrief({ result, keys }: { result: ReportCaseResult | null; keys: string[] }) {
  if (result === null) return <p className={s.none}>No answer yet</p>;
  if (result.answer !== null) {
    const answer = result.answer;
    const reason = typeof answer.reason === "string" && !keys.includes("reason") ? answer.reason : null;
    return (
      <>
        <dl className={s.fields}>
          {keys.map((key) => (
            <div key={key} className={s.field}>
              <dt>{key}</dt>
              <dd>{clip(valueText(answer[key]), 160)}</dd>
            </div>
          ))}
        </dl>
        {reason !== null && <p className={s.reason}>{clip(reason, 240)}</p>}
      </>
    );
  }
  return (
    <>
      {result.answerTruncatedChars !== null && <CutLabel kept={null} total={result.answerTruncatedChars} />}
      {result.answerText !== null ? (
        <p className={s.reason}>
          <span className={s.rawTag}>Raw reply</span> {clip(result.answerText, 240)}
        </p>
      ) : (
        result.answerTruncatedChars === null && <p className={s.none}>No answer</p>
      )}
    </>
  );
}

/** One answer in full, for the expanded row: the whole parsed answer, or the raw reply, and the time it took. */
export function AnswerFull({ result }: { result: ReportCaseResult | null }) {
  if (result === null) return <p className={s.none}>No answer yet</p>;
  return (
    <>
      {result.answer !== null && <pre className={s.pre}>{JSON.stringify(result.answer, null, 2)}</pre>}
      {result.answerTruncatedChars !== null && <CutLabel kept={null} total={result.answerTruncatedChars} />}
      {result.answer === null && result.answerText !== null && (
        <>
          <p className={s.rawTag}>Raw reply</p>
          <pre className={s.pre}>{result.answerText}</pre>
        </>
      )}
      {result.answer === null && result.answerText === null && result.answerTruncatedChars === null && (
        <p className={s.none}>No answer</p>
      )}
      <p className={s.latency}>Took {seconds(result.latencyMs)}</p>
    </>
  );
}
