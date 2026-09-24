"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../reduced-motion";

/*
 * A number that eases toward its target instead of jumping, so a total visibly climbs as each
 * answer lands. It picks up from wherever it was, so a quick run of arrivals never restarts from
 * zero. With reduced motion it simply shows the target.
 */
export function useCountUp(target: number, from = target, durationMs = 700): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(from);
  const current = useRef(from);

  useEffect(() => {
    if (reduced) {
      current.current = target;
      setValue(target);
      return;
    }
    const start = current.current;
    if (start === target) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      current.current = start + (target - start) * eased;
      setValue(current.current);
      if (p < 1) raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [target, reduced, durationMs]);

  return value;
}
