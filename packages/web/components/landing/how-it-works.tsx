"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { HowData, RequestSnippet } from "../../lib/landing-data";
import { Slash } from "../brand/slash";
import l from "./landing.module.css";
import { EASE_OUT, Reveal, rise, SectionMarker } from "./reveal";

const NUMBER = new Intl.NumberFormat("en-US");

function Line({ ind = 0, children, className }: { ind?: number; children?: ReactNode; className?: string }) {
  return (
    <span className={className ? `${l.codeLine} ${className}` : l.codeLine} style={{ "--ind": ind } as CSSProperties}>
      {children ?? <>&nbsp;</>}
    </span>
  );
}

const Q = ({ children }: { children: ReactNode }) => <span className={l.str}>&quot;{children}&quot;</span>;
const K = ({ children }: { children: ReactNode }) => (
  <>
    <span className={l.k}>&quot;{children}&quot;</span>
    <span className={l.p}>: </span>
  </>
);
const P = ({ children }: { children: ReactNode }) => <span className={l.p}>{children}</span>;

// Code lines type in one after another as the card arrives.
const typeIn = {
  hidden: { opacity: 0, x: -8 },
  shown: (i: number) => ({ opacity: 1, x: 0, transition: { delay: 0.25 + i * 0.05, duration: 0.45, ease: EASE_OUT } }),
};

function Typed({ lines }: { lines: ReactNode[] }) {
  return (
    <pre className={l.code}>
      {lines.map((line, i) => (
        <motion.span key={i} custom={i} variants={typeIn} style={{ display: "block" }}>
          {line}
        </motion.span>
      ))}
    </pre>
  );
}

function WorkloadCard({ w }: { w: HowData["workload"] }) {
  const lines: ReactNode[] = [
    <Line key="o">
      <P>{"{"}</P>
    </Line>,
    <Line key="n" ind={1}>
      <K>name</K>
      <Q>{w.name}</Q>
      <P>,</P>
    </Line>,
    <Line key="sp" ind={1}>
      <K>systemPrompt</K>
    </Line>,
    ...w.promptLines.map((text, i) => (
      <Line key={`p${i}`} ind={2}>
        <Q>{text}</Q>
      </Line>
    )),
    <Line key="rest" ind={2} className={l.note}>
      {`// ${NUMBER.format(w.promptRestChars)} more characters of rules`}
    </Line>,
    <Line key="as" ind={1}>
      <K>answerSchema</K>
      <P>{"{ "}</P>
      {w.schemaFields.map((field, i) => (
        <span key={field}>
          <span className={field === w.scoredField ? l.k : l.str}>{field}</span>
          {i < w.schemaFields.length - 1 && <P>, </P>}
        </span>
      ))}
      <P>{" }"}</P>
    </Line>,
    <Line key="c" ind={1}>
      <K>cases</K>
      <P>[</P>
    </Line>,
    <Line key="c1" ind={2}>
      <P>{"{ "}</P>
      <K>id</K>
      <Q>{w.sampleCase.id}</Q>
      <P>, </P>
      <K>expected</K>
      <P>{"{ "}</P>
      <K>{w.scoredField}</K>
      <Q>{w.sampleCase.expected}</Q>
      <P>{" } },"}</P>
    </Line>,
    <Line key="more" ind={2} className={l.note}>
      {`// ${w.caseCount - 1} more cases, each with its right answer`}
    </Line>,
    <Line key="ce" ind={1}>
      <P>]</P>
    </Line>,
    <Line key="e">
      <P>{"}"}</P>
    </Line>,
  ];

  return (
    <motion.div className={`${l.workloadCard} ${l.tiltLeft}`} variants={rise}>
      <div className={l.card}>
        <div className={l.cardBar}>
          <span className={l.cardBarName}>
            <Slash className={l.cardBarSlash} />
            invoices-good.json
          </span>
          <span>{w.caseCount} cases</span>
        </div>
        <Typed lines={lines} />
      </div>
    </motion.div>
  );
}

function host(url: string): { host: string; path: string } {
  const u = new URL(url);
  return { host: u.host, path: u.pathname };
}

/*
 * One side of the side-by-side request. Both sides get the same number of lines so the eye can
 * run across them, and the line that differs lines up with a blank or a note on the other side.
 */
function RequestCard({ req, other }: { req: RequestSnippet; other: RequestSnippet }) {
  const off = req.headers.length > 0 && other.headers.length === 0;
  const { host: h, path } = host(req.url);
  const headerRows = Math.max(req.headers.length, other.headers.length, 1);
  const anyTools = req.tools.length > 0 || other.tools.length > 0;

  const lines: ReactNode[] = [
    <Line key="post">
      <span className={l.k}>POST</span> <span className={l.str}>{path}</span>
    </Line>,
    ...Array.from({ length: headerRows }, (_, i) => {
      const header = req.headers[i];
      if (header === undefined) {
        return (
          <Line key={`h${i}`} className={l.note}>
            {i === 0 ? "// no extra header: SERV is on" : null}
          </Line>
        );
      }
      return (
        <Line key={`h${i}`} className={l.hot}>
          <motion.span
            className={l.hotMark}
            aria-hidden="true"
            variants={{ hidden: { scaleX: 0 }, shown: { scaleX: 1, transition: { delay: 0.9, duration: 0.7, ease: EASE_OUT } } }}
          />
          {header[0]}: {header[1]}
        </Line>
      );
    }),
    <Line key="o">
      <P>{"{"}</P>
    </Line>,
    <Line key="m" ind={1}>
      <K>model</K>
      <Q>{req.model}</Q>
      <P>,</P>
    </Line>,
    <Line key="msg" ind={1}>
      <K>messages</K>
      <P>[ system: your rules, user: one case ],</P>
    </Line>,
    <Line key="rf" ind={1}>
      <K>response_format</K>
      <P>your answer schema</P>
      {anyTools && <P>,</P>}
    </Line>,
    ...(anyTools
      ? [
          req.tools.length > 0 ? (
            <Line key="t" ind={1}>
              <span className={l.plus} aria-hidden="true">
                +
              </span>
              <K>tools</K>
              <P>[ </P>
              {req.tools.map((tool) => (
                <Q key={tool}>{tool}</Q>
              ))}
              <P> ]</P>
            </Line>
          ) : (
            <Line key="t" />
          ),
        ]
      : []),
    <Line key="e">
      <P>{"}"}</P>
    </Line>,
  ];

  return (
    <motion.div className={`${l.card} ${off ? l.reqOff : l.reqOn}`} variants={rise}>
      <div className={l.cardBar}>
        <span className={l.cardBarName}>
          <Slash className={l.cardBarSlash} />
          {req.label}
        </span>
        <span className={l.cardHost}>{h}</span>
      </div>
      <Typed lines={lines} />
    </motion.div>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 5.3 4.2 7.5 8.2 2.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 3 7 7M7 3 3 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const CELL_CLASS = { right: l.cellRight, wrong: l.cellWrong, none: l.cellNone } as const;

function CaseGrid({ grid, gridRef }: { grid: HowData["grid"]; gridRef: RefObject<HTMLDivElement | null> }) {
  const split = new Set(grid.disagreements);
  const splitIds = grid.disagreements.map((i) => grid.caseIds[i]).filter((id): id is string => id !== undefined);
  return (
    <motion.div ref={gridRef} className={l.gridWrap} variants={rise}>
      {grid.rows.map((row, r) => (
        <div key={row.label} className={l.gridRow}>
          <span className={l.gridLabel}>{row.label}</span>
          <div
            className={l.cells}
            role="img"
            aria-label={`${row.label}: ${row.correct} of ${row.calls} cases right`}
          >
            {row.cells.map((cell, i) => (
              <span
                key={grid.caseIds[i] ?? i}
                className={`${l.cell} ${CELL_CLASS[cell]} ${split.has(i) ? l.cellSplit : ""}`}
                style={{ "--i": i + r * 4 } as CSSProperties}
                title={`${grid.caseIds[i] ?? ""}: ${cell}`}
              >
                {cell === "right" ? <Tick /> : cell === "wrong" ? <Cross /> : null}
              </span>
            ))}
          </div>
          <span className={l.gridScore}>
            <b>{row.correct}</b> / {row.calls}
          </span>
        </div>
      ))}
      <p className={l.gridNote}>
        <span className={l.key}>
          <span className={`${l.keySwatch} ${l.cellRight}`} /> right
        </span>
        <span className={l.key}>
          <span className={`${l.keySwatch} ${l.cellWrong}`} /> wrong
        </span>
        {splitIds.length > 0 && (
          <span className={`${l.key} ${l.keySplit}`}>
            <span className={`${l.keySwatch} ${l.cellSplit}`} /> they disagree: {splitIds.join(", ")}
          </span>
        )}
      </p>
    </motion.div>
  );
}

function seconds(ms: number | null): string | null {
  return ms === null ? null : `${(ms / 1000).toFixed(1)} s`;
}

function MiniReport({ v }: { v: HowData["verdict"] }) {
  return (
    <motion.div className={`${l.card} ${l.report}`} variants={rise}>
      <div className={l.cardBar}>
        <span className={l.cardBarName}>
          <Slash className={l.cardBarSlash} />
          Report
        </span>
        <span>{v.cases} cases</span>
      </div>
      <p className={l.reportName}>{v.name}</p>
      <div className={l.reportCols}>
        {v.configs.map((c, i) => (
          <div key={c.label} className={`${l.reportCol} ${c.off ? "" : l.reportOn}`}>
            <span className={l.reportLabel}>{c.label}</span>
            <p className={l.reportPct}>
              {c.pct}
              <small>%</small>
            </p>
            <div className={l.miniTrack} style={{ "--acc": c.accuracy } as CSSProperties}>
              <motion.span
                className={l.miniFill}
                variants={{
                  hidden: { scaleX: 0 },
                  shown: { scaleX: 1, transition: { delay: 0.5 + i * 0.2, duration: 1.1, ease: EASE_OUT } },
                }}
              />
            </div>
            <p className={l.reportStats}>
              <span>
                <span className={l.right}>{c.correct} right</span>
                {c.calls - c.correct > 0 && (
                  <>
                    , <span className={l.wrong}>{c.calls - c.correct} wrong</span>
                  </>
                )}
              </span>
              {c.tokens !== null && (
                <span>
                  <b>{NUMBER.format(c.tokens)}</b> tokens
                </span>
              )}
              {seconds(c.meanLatencyMs) !== null && <span>{seconds(c.meanLatencyMs)} a case, on average</span>}
            </p>
          </div>
        ))}
      </div>
      <div className={l.reportFoot}>
        <p className={l.reportSplit}>
          They disagreed on <b>{v.disagreements}</b> of {v.cases} cases
          {v.tokenChange !== null && v.tokenChange !== 0 && (
            <>
              . SERV used <b>{Math.abs(v.tokenChange)}%</b> {v.tokenChange < 0 ? "fewer" : "more"} tokens
            </>
          )}
          .
        </p>
        <Link href={v.reportHref} className={l.textLink}>
          Open this report
          <span className={l.textArrow} aria-hidden="true">
            &rarr;
          </span>
        </Link>
      </div>
    </motion.div>
  );
}

// The big step numbers sit back behind their titles, so they rise to a faint gold, not full.
const riseFaint = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 0.22, y: 0, transition: { duration: 0.9, ease: EASE_OUT } },
};

function StepText({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className={l.stepText}>
      <motion.span className={l.stepNum} aria-hidden="true" variants={riseFaint}>
        {n}
      </motion.span>
      <motion.h3 className={l.stepTitle} variants={rise}>
        {title}
      </motion.h3>
      <motion.p className={l.stepBody} variants={rise}>
        {children}
      </motion.p>
    </div>
  );
}

/*
 * Three beats down one gold thread. The thread and the case grid are driven by scroll through
 * CSS variables written straight to the DOM, so React never re-renders while the page moves.
 * With reduced motion both variables stay at 1 and everything is simply there.
 */
export function HowItWorks({ data }: { data: HowData }) {
  const storyRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const story = storyRef.current;
    const grid = gridRef.current;
    if (story === null || grid === null) return;
    gsap.registerPlugin(ScrollTrigger);

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const publish = (el: HTMLElement, name: string) => (self: ScrollTrigger) =>
        el.style.setProperty(name, self.progress.toFixed(4));
      const thread = ScrollTrigger.create({
        trigger: story,
        start: "top 65%",
        end: "bottom 65%",
        onUpdate: publish(story, "--how"),
      });
      const fill = ScrollTrigger.create({
        trigger: grid,
        start: "top 92%",
        end: "bottom 72%",
        onUpdate: publish(grid, "--fill"),
      });
      publish(story, "--how")(thread);
      publish(grid, "--fill")(fill);
      return () => {
        story.style.removeProperty("--how");
        grid.style.removeProperty("--fill");
      };
    });
    return () => mm.revert();
  }, []);

  const [off, on] = data.requests;

  return (
    <MotionConfig reducedMotion="user">
      <section id="how" className={l.section} aria-labelledby="how-title">
        <Reveal className={l.head}>
          <div>
            <SectionMarker>How it works</SectionMarker>
            <motion.h2 id="how-title" className={l.title} variants={rise}>
              <span className={l.titleLine}>Your cases.</span>
              <span className={l.titleLine}>Both ways.</span>
              <em className={`${l.titleLine} ${l.gold}`}>One verdict.</em>
            </motion.h2>
          </div>
          <motion.p className={`${l.lead} ${l.headLead}`} variants={rise}>
            Urai sends every one of your test cases to SERV twice, once with SERV Reasoning on and once with it off,
            and scores each answer against the one you wrote down.
          </motion.p>
        </Reveal>

        <div ref={storyRef} className={l.story}>
          <div className={l.thread} aria-hidden="true" />

          <Reveal className={l.step} amount={0.25}>
            <Slash className={l.stepNode} />
            <StepText n="01" title="Bring your agent">
              The rules your agent runs on, the shape of the answer it gives, and test cases with the right answer
              for each. This is a real one: an invoice approver that must say <code>pay</code>, <code>hold</code> or{" "}
              <code>reject</code>.
            </StepText>
            <WorkloadCard w={data.workload} />
          </Reveal>

          <Reveal className={`${l.step} ${l.stepWide}`} amount={0.15}>
            <Slash className={l.stepNode} />
            <div className={l.stepWideHead}>
              <StepText n="02" title="Run it both ways">
                The same request goes out twice. One header turns SERV off: with it, SERV steps aside and your model
                answers alone.
              </StepText>
              {on.tools.length > 0 && (
                <motion.p className={l.stepAside} variants={rise}>
                  <span className={l.k}>+</span> On the SERV side Urai also adds {on.tools.join(", ")}, because
                  SERV&apos;s output filter otherwise cuts answers that quote your rules.
                </motion.p>
              )}
            </div>
            <div className={l.pair}>
              <RequestCard req={off} other={on} />
              <RequestCard req={on} other={off} />
            </div>
            <CaseGrid grid={data.grid} gridRef={gridRef} />
          </Reveal>

          <Reveal className={`${l.step} ${l.stepFlip}`} amount={0.25}>
            <Slash className={l.stepNode} />
            <StepText n="03" title="Read the verdict">
              Accuracy for each side, what it cost in tokens, how long it took, and every case where the two
              disagreed, so you can open the answer and see why.
            </StepText>
            <MiniReport v={data.verdict} />
          </Reveal>
        </div>
      </section>
    </MotionConfig>
  );
}
