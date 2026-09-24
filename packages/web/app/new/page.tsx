import { LIMITS, parseWorkload, type Workload } from "@urai/engine";
import type { Metadata } from "next";
import badJson from "../../../engine/workloads/invoices-bad.json";
import goodJson from "../../../engine/workloads/invoices-good.json";
import hardJson from "../../../engine/workloads/invoices-hard.json";
import { Slash } from "../../components/brand/slash";
import { Stone } from "../../components/brand/stone";
import { Builder } from "../../components/new/builder";
import type { FormLimits, SampleEntry } from "../../components/new/draft";
import s from "../../components/new/new.module.css";
import { Footer } from "../../components/site/footer";
import { Header } from "../../components/site/header";
import { SmoothScroll } from "../../components/smooth-scroll";
import { CONFIG } from "../../lib/config";

export const metadata: Metadata = {
  title: "Test your agent",
  description: "Bring your own AI agent to Urai: its rules, its answer shape and its test cases. Check the setup, then run it with SERV off and SERV on, on your own key.",
};

// The caps go down as plain numbers, so the engine itself never ships to the browser.
const LIMITS_FOR_FORM: FormLimits = {
  nameMaxChars: LIMITS.nameMaxChars,
  systemPromptMaxChars: LIMITS.systemPromptMaxChars,
  contextMaxChars: LIMITS.contextMaxChars,
  caseInputMaxChars: LIMITS.caseInputMaxChars,
  casesMax: LIMITS.casesMax,
  caseIdMaxChars: LIMITS.caseIdMaxChars,
  scoringRulesMax: LIMITS.scoringRulesMax,
  configsPerRunMax: CONFIG.configsPerRunMax,
  keyMinChars: LIMITS.keyMinChars,
  keyMaxChars: LIMITS.keyMaxChars,
  bodyMaxBytes: CONFIG.bodyMaxBytes,
};

// Checked with the same parser the API uses, so a sample that drifted out of shape fails the build, not a visitor's run.
function sample(json: unknown, file: string): Workload {
  const parsed = parseWorkload(json);
  if (!parsed.ok) throw new Error(`${file} is not a valid workload: ${parsed.errors.slice(0, 3).join("; ")}`);
  return parsed.workload;
}

const SAMPLES: SampleEntry[] = [
  {
    slug: "bad",
    title: "Data in the wrong place",
    line: "The payables agent with its supplier book pasted into the system prompt. The setup check catches it and fixes it in one click.",
    workload: sample(badJson, "invoices-bad.json"),
  },
  {
    slug: "good",
    title: "The same agent, set up right",
    line: "Rules in the system prompt, supplier data in shared data. The fair test of what SERV changes.",
    workload: sample(goodJson, "invoices-good.json"),
  },
  {
    slug: "hard",
    title: "The hard rulebook",
    line: "152 clauses from four layered rule sources, where one missed exception flips a payment.",
    workload: sample(hardJson, "invoices-hard.json"),
  },
];

const META = ["Your agent", "Your SERV key", "One page", "Nothing spent until Start"] as const;

export default function NewPage() {
  return (
    <>
      <SmoothScroll />
      <Stone streak={false} />
      <Header />
      <main className={s.root}>
        <section className={s.intro} aria-labelledby="new-title">
          <p className={`${s.meta} ${s.enter}`} style={{ animationDelay: "0.05s" }}>
            {META.map((item, i) => (
              <span key={item} className={s.metaItem}>
                {i > 0 && <Slash className={s.metaSlash} />}
                {item}
              </span>
            ))}
          </p>
          <h1 id="new-title" className={s.headline} aria-label="Bring your own agent.">
            <span className={s.line}>
              <span className={s.rise} style={{ animationDelay: "0.1s" }}>
                Bring your
              </span>
            </span>
            <span className={s.line}>
              <span className={s.rise} style={{ animationDelay: "0.22s" }}>
                <em className={s.goldWord}>own agent.</em>
              </span>
            </span>
          </h1>
          <div className={s.ledeRow}>
            <p className={`${s.lede} ${s.enter}`} style={{ animationDelay: "0.42s" }}>
              Paste its rules, the shape of a right answer and the cases you already know. Urai checks the setup, then
              runs every case with <strong>SERV off and SERV on</strong>, side by side, on your own key.
            </p>
          </div>
        </section>

        <Builder samples={SAMPLES} limits={LIMITS_FOR_FORM} />
        <div className={s.tail} />
      </main>
      <Footer />
    </>
  );
}
