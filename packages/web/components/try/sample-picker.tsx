"use client";

import { motion } from "motion/react";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Slash } from "../brand/slash";
import type { CreateOutcome } from "./api";
import s from "./try.module.css";
import { percent, type SampleChoice } from "./types";

const EASE = [0.16, 1, 0.3, 1] as const;

export interface SamplePickerProps {
  samples: SampleChoice[];
  cases: number;
  selected: string | null;
  onSelect: (workloadId: string) => void;
  onStart: () => void;
  starting: boolean;
  startError: Exclude<CreateOutcome, { kind: "created" }> | null;
}

export const STORAGE_FULL = "Urai's storage is full for now; nothing was charged. Open one of the saved reports above, or try again later.";

export function startErrorText(err: Exclude<CreateOutcome, { kind: "created" }>): string {
  switch (err.kind) {
    case "rate_limited":
      return "You have started a lot of demo runs from this address in the last hour. Give it a while, or open one of the saved reports above: each one ran every case.";
    case "network":
      return "Urai could not be reached. Check your connection, then press Run it live again.";
    case "refused":
      if (err.status === 503 && err.code === "storage_full") return STORAGE_FULL;
      if (err.status === 403 || err.status === 404) {
        return "This sample is not open for live runs right now. Its saved report above still shows a full run, or pick another sample.";
      }
      return `The run could not start (${err.code}). Nothing was spent. Try again in a moment.`;
  }
}

/*
 * The three sample agents as an assay list: one ruled row each, the chosen row lit with a gold
 * rule. Each row carries the real result of that sample's saved full run, so a visitor knows what
 * the live run is being compared against before pressing start.
 */
export function SamplePicker({ samples, cases, selected, onSelect, onStart, starting, startError }: SamplePickerProps) {
  const chosen = samples.find((x) => x.workloadId === selected) ?? null;
  const calls = chosen === null ? 0 : cases * chosen.configs.length;

  return (
    <section id="pick" className={s.section} style={{ scrollMarginTop: "88px" }} aria-labelledby="pick-title">
      <motion.p
        className={s.marker}
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.6 }}
        transition={{ duration: 0.8, ease: EASE }}
      >
        <Slash className={s.markerSlash} />
        <span id="pick-title">Pick a sample agent</span>
      </motion.p>

      {/* The radio group wraps the list, so each row stays a list item inside a real list. */}
      <div role="radiogroup" aria-labelledby="pick-title">
      <motion.ol
        className={s.list}
        initial="hidden"
        whileInView="shown"
        viewport={{ once: true, amount: 0.15 }}
        transition={{ staggerChildren: 0.1 }}
      >
        {samples.map((sample, i) => {
          const available = sample.configs.length > 0;
          const isOn = sample.workloadId === selected;
          const inputId = `sample-${sample.workloadId}`;
          return (
            <motion.li
              key={sample.workloadId}
              className={s.item}
              data-selected={isOn}
              data-disabled={!available}
              variants={{ hidden: { opacity: 0, y: 24 }, shown: { opacity: 1, y: 0 } }}
              transition={{ duration: 0.8, ease: EASE }}
            >
              <label className={s.choice} htmlFor={inputId}>
                <input
                  id={inputId}
                  className={s.srOnly}
                  type="radio"
                  name="sample"
                  value={sample.workloadId}
                  checked={isOn}
                  disabled={!available || starting}
                  onChange={() => onSelect(sample.workloadId)}
                />
                <span className={s.index} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                  <Slash className={s.indexSlash} />
                </span>
                <span>
                  <span className={s.name}>{sample.name}</span>
                  <span className={s.itemLine}>{sample.line}</span>
                  {!available && <span className={s.unavailable}>Not open for live runs right now</span>}
                </span>
              </label>

              <SavedResult sample={sample} />
            </motion.li>
          );
        })}
      </motion.ol>
      </div>

      <motion.div
        className={s.startBar}
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.8, ease: EASE }}
      >
        <button type="button" className={s.primary} onClick={onStart} disabled={chosen === null || starting}>
          {starting ? (
            <>
              <span className={s.spinner} aria-hidden="true" />
              <span>Starting the run</span>
            </>
          ) : (
            <>
              <span>Run it live</span>
              <span className={s.arrow} aria-hidden="true">
                &rarr;
              </span>
            </>
          )}
        </button>
        <p className={s.startNote}>
          <Slash className={s.noteSlash} />
          <span>
            {calls > 0 ? `${calls} real calls, three at a time.` : "Pick a sample to start."} Each takes about 5 to 15
            seconds, because every call carries the whole rulebook. You pay nothing and need no key.
          </span>
        </p>
      </motion.div>

      {startError !== null && (
        <p className={s.notice} role="alert">
          {startErrorText(startError)}
        </p>
      )}
    </section>
  );
}

function SavedResult({ sample }: { sample: SampleChoice }) {
  const saved = sample.saved;
  if (saved === null) {
    return (
      <div className={s.saved}>
        <p className={s.savedMissing}>The saved full run for this sample could not be loaded just now.</p>
      </div>
    );
  }
  return (
    <div className={s.saved}>
      <p className={s.savedHead}>Saved run, all {saved.cases} cases</p>
      {saved.columns.map((col) => (
        <div key={col.label} className={s.savedRow}>
          <span className={s.savedLabel}>{col.label}</span>
          <span className={s.savedTrack} aria-hidden="true">
            <span className={s.savedFill} style={{ width: `${col.accuracy * 100}%` } as CSSProperties} />
          </span>
          <span className={s.savedPct} aria-label={`${percent(col.accuracy)} percent, ${col.correct} of ${col.calls} right`}>
            {percent(col.accuracy)}
            <small>%</small>
          </span>
        </div>
      ))}
      <div>
        <Link href={`/r/${saved.reportId}`} className={s.textLink}>
          <span>Open the saved report</span>
          <span className={s.arrow} aria-hidden="true">
            &rarr;
          </span>
        </Link>
      </div>
    </div>
  );
}
