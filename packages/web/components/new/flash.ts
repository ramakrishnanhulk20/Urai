"use client";

import { useEffect, useRef, type RefObject } from "react";

const KEYFRAMES: Keyframe[] = [
  { borderColor: "#f4d58c", boxShadow: "0 0 0 4px rgb(226 176 74 / 0.45), 0 0 56px -6px rgb(226 176 74 / 0.55)" },
  { borderColor: "rgb(239 233 223 / 0.18)", boxShadow: "0 0 0 0 rgb(226 176 74 / 0)" },
];

/*
 * Glows a field gold once each time `signal` changes, so text a sample or the layout fix just
 * rewrote is easy to spot. Driven through the Web Animations API rather than a remount, because a
 * remount would throw away the textarea's own undo history and the caret.
 */
export function useFlash<T extends HTMLElement>(signal: number): RefObject<T | null> {
  const ref = useRef<T>(null);
  const last = useRef(signal);
  useEffect(() => {
    if (last.current === signal) return;
    last.current = signal;
    const el = ref.current;
    if (el === null || typeof el.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(KEYFRAMES, { duration: 1600, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }, [signal]);
  return ref;
}
