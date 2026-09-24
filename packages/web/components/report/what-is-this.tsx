import Link from "next/link";
import { Slash } from "../brand/slash";
import s from "./report.module.css";

/** For the visitor who opens a report link cold: what Urai is, in one paragraph, and where to go next. */
export function WhatIsThis() {
  return (
    <aside className={s.what} aria-labelledby="what-title">
      <h2 id="what-title" className={s.whatTitle}>
        <Slash className={s.whatSlash} />
        What is this?
      </h2>
      <p className={s.whatText}>
        Urai tests SERV Reasoning on an AI agent before its team switches it on. It runs the agent&apos;s own test
        cases with SERV on and off, side by side, scores every answer, counts the tokens, and checks the setup for
        the mistakes that quietly cost accuracy. This page is one of those runs, shared by the team that ran it.
      </p>
      <p className={s.whatLinks}>
        <Link href="/" className={s.textLink}>
          How Urai works
        </Link>
        <Link href="/try" className={s.textLink}>
          Try the live demo
        </Link>
      </p>
    </aside>
  );
}
