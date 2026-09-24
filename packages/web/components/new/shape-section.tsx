"use client";

import type { ScoreRule } from "@urai/engine";
import { nextRowKey, type Draft, type FormLimits, type SchemaRead, type ScoreRow } from "./draft";
import { useFlash } from "./flash";
import s from "./new.module.css";
import { Section } from "./parts";

const RULES: { rule: ScoreRule["rule"]; label: string }[] = [
  { rule: "exact", label: "Exact match" },
  { rule: "number", label: "Number, with tolerance" },
  { rule: "oneOf", label: "One of a list" },
];

export interface ShapeSectionProps {
  draft: Draft;
  schema: SchemaRead;
  limits: FormLimits;
  flash: number;
  onChange: (patch: Partial<Draft>) => void;
}

export function ShapeSection({ draft, schema, limits, flash, onChange }: ShapeSectionProps) {
  const schemaRef = useFlash<HTMLTextAreaElement>(flash);
  const fields = schema.ok ? schema.fields : [];
  const taken = new Set(draft.scoring.map((r) => r.field));

  const setRow = (key: number, patch: Partial<ScoreRow>): void =>
    onChange({ scoring: draft.scoring.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const addRow = (): void => {
    const free = fields.find((f) => !taken.has(f)) ?? "";
    onChange({ scoring: [...draft.scoring, { key: nextRowKey(), field: free, rule: "exact", tolerance: "" }] });
  };

  return (
    <Section
      id="shape"
      index={3}
      marker="Answer shape"
      title={
        <>
          What a right
          <br />
          answer looks like.
        </>
      }
      lede="The JSON Schema your agent answers in, and which of its fields decide whether an answer is right. Only the scored fields count toward accuracy."
    >
      <div className={s.fields}>
        <label className={s.field}>
          <span className={s.labelRow}>
            <span className={s.label}>Answer JSON Schema</span>
          </span>
          <textarea
            ref={schemaRef}
            className={`${s.textarea} ${s.medium}`}
            value={draft.schemaText}
            onChange={(e) => onChange({ schemaText: e.target.value })}
            placeholder={'{\n  "type": "object",\n  "properties": { "verdict": { "type": "string", "enum": ["pay", "hold", "reject"] } },\n  "required": ["verdict"],\n  "additionalProperties": false\n}'}
            aria-invalid={!schema.ok && !schema.empty}
            aria-describedby="schema-feedback"
            spellCheck={false}
            data-lenis-prevent
          />
          <span id="schema-feedback" className={s.feedback} data-tone={schema.ok ? "ok" : schema.empty ? undefined : "bad"} aria-live="polite">
            {schema.ok
              ? `Valid JSON. ${schema.fields.length} ${schema.fields.length === 1 ? "field" : "fields"}: ${schema.fields.join(", ")}.`
              : schema.message}
          </span>
        </label>

        <div className={s.field}>
          <span className={s.labelRow}>
            <span className={s.label}>Scoring rules</span>
            <span className={s.count}>
              {draft.scoring.length} / {limits.scoringRulesMax}
            </span>
          </span>
          <span className={s.hint}>
            Exact match ignores case and extra spaces. A number rule passes when the answer is within the tolerance. One
            of a list passes when the answer matches any option.
          </span>
          {draft.scoring.length > 0 && (
            <ul className={s.rules}>
              {draft.scoring.map((row, i) => (
                <li key={row.key} className={s.rule}>
                  <label className={s.ruleLabel}>
                    Field
                    <select
                      className={s.select}
                      value={row.field}
                      onChange={(e) => setRow(row.key, { field: e.target.value })}
                      aria-label={`Scoring rule ${i + 1}: field`}
                    >
                      <option value="">Pick a field</option>
                      {row.field !== "" && !fields.includes(row.field) && <option value={row.field}>{row.field} (not in schema)</option>}
                      {fields.map((f) => (
                        <option key={f} value={f} disabled={f !== row.field && taken.has(f)}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={s.ruleLabel}>
                    Rule
                    <select
                      className={s.select}
                      value={row.rule}
                      onChange={(e) => setRow(row.key, { rule: e.target.value as ScoreRule["rule"] })}
                      aria-label={`Scoring rule ${i + 1}: rule`}
                    >
                      {RULES.map((r) => (
                        <option key={r.rule} value={r.rule}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={s.ruleLabel}>
                    Tolerance
                    <input
                      className={s.input}
                      inputMode="decimal"
                      value={row.rule === "number" ? row.tolerance : ""}
                      onChange={(e) => setRow(row.key, { tolerance: e.target.value })}
                      placeholder={row.rule === "number" ? "0" : "n/a"}
                      disabled={row.rule !== "number"}
                      aria-label={`Scoring rule ${i + 1}: tolerance`}
                    />
                  </label>
                  <button
                    type="button"
                    className={s.remove}
                    onClick={() => onChange({ scoring: draft.scoring.filter((r) => r.key !== row.key) })}
                    aria-label={`Remove scoring rule ${i + 1}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={s.row}>
            <button
              type="button"
              className={s.secondary}
              onClick={addRow}
              disabled={draft.scoring.length >= limits.scoringRulesMax}
            >
              <span>Add a scoring rule</span>
            </button>
            {!schema.ok && <span className={s.hint}>The field list fills in once the schema reads as valid JSON.</span>}
          </div>
        </div>
      </div>
    </Section>
  );
}
