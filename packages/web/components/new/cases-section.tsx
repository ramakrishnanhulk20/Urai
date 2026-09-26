"use client";

import type { ExpectedValue, ScoreRule } from "@urai/engine";
import { useState, type ChangeEvent } from "react";
import { Slash } from "../brand/slash";
import type { CasesParse } from "./cases";
import type { Draft, FormLimits } from "./draft";
import { useFlash } from "./flash";
import s from "./new.module.css";
import { Section } from "./parts";

const PREVIEW_ROWS = 3;
const PROBLEMS_SHOWN = 50;

export interface CasesSectionProps {
  draft: Draft;
  parsed: CasesParse;
  scoring: ScoreRule[];
  limits: FormLimits;
  flash: number;
  onChange: (patch: Partial<Draft>) => void;
}

function showValue(v: ExpectedValue | undefined): string {
  if (v === undefined) return "";
  if (Array.isArray(v)) return v.join(" | ");
  return v === null ? "null" : String(v);
}

function csvExample(scoring: ScoreRule[]): string {
  const fields = scoring.length > 0 ? scoring.map((r) => `expected.${r.field}`) : ["expected.verdict"];
  return ["id", "input", ...fields].join(",");
}

export function CasesSection({ draft, parsed, scoring, limits, flash, onChange }: CasesSectionProps) {
  const casesRef = useFlash<HTMLTextAreaElement>(flash);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const shownFields = scoring.map((r) => r.field);

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file === undefined) return;
    // Anything this big could never fit in one request body, so it is refused before it is read.
    if (file.size > limits.bodyMaxBytes) {
      setFileNote(`${file.name} is ${Math.round(file.size / 1024)} KB. A whole test set must fit in ${Math.round(limits.bodyMaxBytes / 1024)} KB; trim it and upload again.`);
      return;
    }
    file.text().then(
      (text) => {
        setFileNote(`Loaded ${file.name}.`);
        onChange({ casesText: text });
      },
      () => setFileNote(`Could not read ${file.name}. Save it as UTF-8 CSV and upload it again.`),
    );
  };

  const shown = parsed.problems.slice(0, PROBLEMS_SHOWN);

  return (
    <Section
      id="cases"
      index={4}
      marker="Test cases"
      title={
        <>
          The cases you
          <br />
          already know.
        </>
      }
      lede={
        <>
          Inputs where you know the right answer. Paste a JSON array, or a CSV with the columns{" "}
          <code className={s.code}>{csvExample(scoring)}</code>. Everything is read here in your browser first.
        </>
      }
    >
      <div className={s.fields}>
        <div className={s.field}>
          <span className={s.labelRow}>
            <label className={s.label} htmlFor="cases-text">
              Cases, JSON or CSV
            </label>
            <span className={s.format}>
              {parsed.format === "empty" ? "Nothing yet" : parsed.format === "json" ? "Read as JSON" : "Read as CSV"}
            </span>
          </span>
          <textarea
            id="cases-text"
            ref={casesRef}
            className={`${s.textarea} ${s.medium}`}
            value={draft.casesText}
            onChange={(e) => {
              // A hand edit means the cases are no longer just what the file held.
              setFileNote(null);
              onChange({ casesText: e.target.value });
            }}
            placeholder={`${csvExample(scoring)}\nINV-01,"Northgate Cloud Services Ltd, invoice NG-4471...",pay`}
            aria-invalid={parsed.problems.length > 0}
            aria-describedby="cases-feedback"
            spellCheck={false}
            data-lenis-prevent
          />
          <div className={s.row}>
            <span className={`${s.secondary} ${s.upload}`}>
              <Slash className={s.secondarySlash} />
              <span>Upload CSV</span>
              <input type="file" accept=".csv,text/csv" onChange={onFile} aria-label="Upload a CSV of test cases" />
            </span>
            <span className={s.hint}>
              One row per case. For a one-of rule, separate the options with <code>|</code>.
            </span>
          </div>
          {fileNote !== null && (
            <p className={s.feedback} role="status">
              {fileNote}
            </p>
          )}
        </div>

        <div id="cases-feedback" className={s.fields} aria-live="polite">
          {parsed.cases.length > 0 && (
            <p className={s.bigCount}>
              <b>{parsed.cases.length}</b>
              <span>
                {parsed.cases.length === 1 ? "case" : "cases"} read, {limits.casesMax} at most
              </span>
            </p>
          )}

          {parsed.cases.length > 0 && (
            <table className={s.preview}>
              <caption className={s.srOnly}>
                {parsed.cases.length === 1 ? "The one case" : `The first ${Math.min(PREVIEW_ROWS, parsed.cases.length)} cases`}
              </caption>
              <thead>
                <tr>
                  <th className={s.colId} scope="col">
                    id
                  </th>
                  <th scope="col">input</th>
                  <th className={s.colExpected} scope="col">
                    expected
                  </th>
                </tr>
              </thead>
              <tbody>
                {parsed.cases.slice(0, PREVIEW_ROWS).map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td>{c.input.replace(/\s+/g, " ").slice(0, 160)}</td>
                    <td className={s.expectedCell}>
                      {shownFields.map((f) => `${f}: ${showValue(c.expected[f])}`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {parsed.problems.length > 0 && (
            <>
              <p className={s.feedback} data-tone="bad">
                {parsed.problems.length} {parsed.problems.length === 1 ? "problem" : "problems"} to fix
                {parsed.cases.length > 0 ? `; the other ${parsed.cases.length} read fine` : ""}. Fix them in your file or
                here, and the list updates as you type.
              </p>
              <ul className={s.problems} data-lenis-prevent>
                {shown.map((p, i) => (
                  <li key={`${p.where ?? "all"}-${i}`}>
                    {p.where !== null && <b>{p.where}</b>}
                    {p.message}
                  </li>
                ))}
                {parsed.problems.length > shown.length && <li>and {parsed.problems.length - shown.length} more.</li>}
              </ul>
            </>
          )}
        </div>
      </div>
    </Section>
  );
}
