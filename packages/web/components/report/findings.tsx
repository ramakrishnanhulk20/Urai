import Link from "next/link";
import type { LintFinding } from "@urai/engine";
import type { Report, TruncatedText } from "../../lib/report";
import { isTruncated } from "./format";
import { Reveal, RevealItem } from "./motion";
import { CutLabel, SectionHead } from "./parts";
import s from "./report.module.css";

const SEVERITY_WORDS: Record<LintFinding["severity"], string> = {
  error: "Must fix",
  warning: "Warning",
  info: "Note",
};

function PromptBlock({ label, value }: { label: string; value: string | TruncatedText }) {
  const cut = isTruncated(value);
  const text = cut ? value.text : value;
  const chars = cut ? value.chars : value.length;
  return (
    <details className={s.prompt}>
      <summary className={s.promptSummary}>
        <span>{label}</span>
        <span className={s.promptSize}>{chars.toLocaleString("en-US")} characters</span>
        <span className={s.chevron} aria-hidden="true" />
      </summary>
      {cut && <CutLabel kept={text.length} total={chars} />}
      <pre className={s.pre} data-lenis-prevent>
        {text}
      </pre>
    </details>
  );
}

/**
 * The lint's findings on the agent's setup, most serious first, and the prompt and shared context
 * the findings are about. A fixable finding points to the builder, where the fix is one click.
 */
export function Findings({ report }: { report: Report }) {
  const order: LintFinding["severity"][] = ["error", "warning", "info"];
  const findings = [...report.lint].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  return (
    <section className={s.section} aria-labelledby="findings-title">
      <SectionHead index="The setup" title="Setup findings" id="findings-title">
        <p>
          {findings.length === 0
            ? "The setup check found nothing to flag in this agent's prompt, schema or settings."
            : "What the setup check noticed about this agent's prompt, schema and settings before a single case ran."}
        </p>
      </SectionHead>

      {findings.length > 0 && (
        <Reveal as="ul" className={s.findings} stagger={0.1}>
          {findings.map((f, i) => (
            <RevealItem as="li" key={`${f.id}-${i}`} className={s.finding}>
              <p className={s.severity} data-severity={f.severity}>
                <span className={s.severityMark} aria-hidden="true" />
                {SEVERITY_WORDS[f.severity] ?? f.severity}
              </p>
              <div className={s.findingBody}>
                <h3 className={s.findingTitle}>{f.title}</h3>
                <p className={s.findingDetail}>{f.detail}</p>
                {f.evidence !== null && (
                  <p className={s.evidence}>
                    <span className={s.smallLabel}>Evidence</span> {f.evidence}
                  </p>
                )}
                {f.fixable && (
                  <p className={s.fixLine}>
                    The one-click fix for this is available in the builder.{" "}
                    <Link href="/new" className={s.textLink}>
                      Open the builder
                    </Link>
                  </p>
                )}
              </div>
            </RevealItem>
          ))}
        </Reveal>
      )}

      <div className={s.prompts}>
        <PromptBlock label="System prompt" value={report.systemPrompt} />
        {report.context !== null && <PromptBlock label="Shared context" value={report.context} />}
      </div>
    </section>
  );
}
