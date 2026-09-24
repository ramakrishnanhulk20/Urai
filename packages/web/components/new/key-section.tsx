"use client";

import { Slash } from "../brand/slash";
import { keyShapeOk, type FormLimits } from "./draft";
import s from "./new.module.css";
import { Section } from "./parts";

const PROMISES = [
  "Used for each call of this run, and for nothing else.",
  "Sent only in a request header, never in a web address.",
  "Never stored and never logged, on our server or in this browser. Reload the page and it is gone.",
] as const;

export interface KeySectionProps {
  value: string;
  limits: FormLimits;
  onChange: (key: string) => void;
}

/*
 * The field has no name and sits in no form, so no browser behaviour can ever submit it as part
 * of a URL. Its value lives in this page's memory until Start hands it to the in-memory session.
 */
export function KeySection({ value, limits, onChange }: KeySectionProps) {
  const filled = value.trim() !== "";
  const ok = keyShapeOk(value, limits);

  return (
    <Section
      id="key"
      index={7}
      marker="Your SERV key"
      title={
        <>
          Your credit,
          <br />
          your key.
        </>
      }
      lede="A run on your agent spends your own SERV credit, so it needs your key. Here is exactly what happens to it."
    >
      <div className={s.keyGrid}>
        <div className={s.field}>
          <span className={s.labelRow}>
            <label className={s.label} htmlFor="serv-key">
              SERV API key
            </label>
          </span>
          <input
            id="serv-key"
            type="password"
            className={s.input}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Paste your key"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={filled && !ok}
            aria-describedby="serv-key-help"
          />
          <p id="serv-key-help" className={s.feedback} data-tone={!filled ? undefined : ok ? "ok" : "bad"}>
            {!filled && (
              <>
                No key yet? Create one at{" "}
                <a className={s.textLink} href="https://console.openserv.ai" target="_blank" rel="noopener noreferrer">
                  console.openserv.ai
                </a>
                .
              </>
            )}
            {filled && ok && "Looks like a key. SERV itself confirms it on the first call."}
            {filled && !ok && `That does not look like a SERV key: keys are ${limits.keyMinChars} to ${limits.keyMaxChars} characters with no spaces.`}
          </p>
        </div>
        <ul className={s.promises}>
          {PROMISES.map((p) => (
            <li key={p}>
              <Slash className={s.promiseSlash} />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
