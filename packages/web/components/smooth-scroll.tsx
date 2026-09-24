"use client";

import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { useEffect } from "react";
import { usePrefersReducedMotion } from "./reduced-motion";

export function SmoothScroll(): null {
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    if (reduced) return;
    const lenis = new Lenis({ autoRaf: true });
    return () => lenis.destroy();
  }, [reduced]);
  return null;
}
