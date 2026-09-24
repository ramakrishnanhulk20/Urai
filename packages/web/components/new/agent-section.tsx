"use client";

import type { Draft, FormLimits } from "./draft";
import { useFlash } from "./flash";
import s from "./new.module.css";
import { Count, Section } from "./parts";

export interface AgentSectionProps {
  draft: Draft;
  limits: FormLimits;
  /** Bumped when a sample or the layout fix rewrites the prompt fields. */
  promptFlash: number;
  onChange: (patch: Partial<Draft>) => void;
}

export function AgentSection({ draft, limits, promptFlash, onChange }: AgentSectionProps) {
  const promptRef = useFlash<HTMLTextAreaElement>(promptFlash);
  const contextRef = useFlash<HTMLTextAreaElement>(promptFlash);
  const nameOver = draft.name.length > limits.nameMaxChars;
  const promptOver = draft.systemPrompt.length > limits.systemPromptMaxChars;
  const contextOver = draft.context.length > limits.contextMaxChars;

  return (
    <Section
      id="agent"
      index={2}
      marker="Your agent"
      title={
        <>
          Its rules,
          <br />
          word for word.
        </>
      }
      lede="Paste the system prompt exactly as your agent sends it today. Urai sends it to SERV byte for byte, so what you measure is what you would ship."
    >
      <div className={s.fields}>
        <label className={s.field}>
          <span className={s.labelRow}>
            <span className={s.label}>Name</span>
            <Count value={draft.name.length} max={limits.nameMaxChars} />
          </span>
          <input
            className={s.input}
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Invoice approvals, support triage, claims review..."
            aria-invalid={nameOver}
            autoComplete="off"
          />
        </label>

        <label className={s.field}>
          <span className={s.labelRow}>
            <span className={s.label}>System prompt</span>
            <Count value={draft.systemPrompt.length} max={limits.systemPromptMaxChars} />
          </span>
          <textarea
            ref={promptRef}
            className={`${s.textarea} ${s.tall}`}
            value={draft.systemPrompt}
            onChange={(e) => onChange({ systemPrompt: e.target.value })}
            placeholder="You decide whether an accounts-payable team should pay a supplier invoice..."
            aria-invalid={promptOver}
            spellCheck={false}
            data-lenis-prevent
          />
          {promptOver && (
            <span className={s.feedback} data-tone="bad">
              Over the limit by {(draft.systemPrompt.length - limits.systemPromptMaxChars).toLocaleString("en-US")} characters.
              Move reference data into the shared data box below.
            </span>
          )}
        </label>

        <label className={s.field}>
          <span className={s.labelRow}>
            <span className={s.label}>
              Shared data<span className={s.optional}>optional</span>
            </span>
            <Count value={draft.context.length} max={limits.contextMaxChars} />
          </span>
          <span className={s.hint}>
            Tables, lists and records every case needs, such as a supplier book or a price list. <strong>Data belongs
            here, not in the system prompt:</strong> SERV compresses the system prompt into its own reasoning graph and
            drops data it finds there. This box travels in the user message instead.
          </span>
          <textarea
            ref={contextRef}
            className={`${s.textarea} ${s.medium}`}
            value={draft.context}
            onChange={(e) => onChange({ context: e.target.value })}
            placeholder={"SUPPLIER BOOK\n| id | legal name | payout account |"}
            aria-invalid={contextOver}
            spellCheck={false}
            data-lenis-prevent
          />
        </label>
      </div>
    </Section>
  );
}
