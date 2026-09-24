"use client";

import Link from "next/link";
import { Slash } from "../brand/slash";
import type { SampleEntry } from "./draft";
import s from "./new.module.css";
import { Section } from "./parts";

export interface SampleRowProps {
  samples: SampleEntry[];
  loaded: SampleEntry["slug"] | null;
  onLoad: (sample: SampleEntry) => void;
}

export function SampleRow({ samples, loaded, onLoad }: SampleRowProps) {
  return (
    <Section
      id="sample"
      index={1}
      marker="Start from a sample"
      title={
        <>
          Borrow one of
          <br />
          our agents.
        </>
      }
      lede="Each button fills every field below with one of our sample invoice agents, so you can see a finished setup before you write your own."
    >
      <div className={s.samples}>
        {samples.map((sample, i) => (
          <button
            key={sample.slug}
            type="button"
            className={s.sample}
            aria-pressed={loaded === sample.slug}
            onClick={() => onLoad(sample)}
          >
            <span className={s.sampleIndex}>
              <Slash />
              Sample {String(i + 1).padStart(2, "0")}
            </span>
            <span className={s.sampleName}>{sample.title}</span>
            <span className={s.sampleLine}>{sample.line}</span>
            <span className={s.sampleFacts}>
              {sample.workload.cases.length} cases, {sample.workload.systemPrompt.length.toLocaleString("en-US")} character prompt
            </span>
          </button>
        ))}
      </div>
      <p className={s.sampleNote}>
        These are sample agents, not yours. Run with your key, they spend <strong>your own SERV credit</strong> like any
        other run. To try them for free, use the <Link className={s.textLink} href="/try">live demo</Link> instead.
      </p>
    </Section>
  );
}
