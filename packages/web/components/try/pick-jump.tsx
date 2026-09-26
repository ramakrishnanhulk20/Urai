"use client";

import type { CSSProperties } from "react";
import { usePrefersReducedMotion } from "../reduced-motion";
import s from "./try.module.css";

/*
 * The first screen's way into the demo: it brings the sample list into view and puts focus on the
 * chosen sample, so a keyboard user lands where the next decision is and Run it live is one Tab away.
 */
export function PickJump({ style }: { style?: CSSProperties }) {
  const reduced = usePrefersReducedMotion();

  const jump = (): void => {
    const list = document.getElementById("pick");
    if (list === null) return;
    list.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    const radio =
      list.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      list.querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)');
    radio?.focus({ preventScroll: true });
  };

  return (
    <div className={`${s.jumpRow} ${s.enter}`} style={style}>
      <button type="button" className={s.primary} onClick={jump}>
        <span>Run it live</span>
        <span className={s.arrow} aria-hidden="true">
          &darr;
        </span>
      </button>
    </div>
  );
}
