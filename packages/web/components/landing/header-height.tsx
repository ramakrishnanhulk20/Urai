"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect } from "react";
import s from "../site/site.module.css";

/*
 * Publishes the sticky site header's real height as --header-h on <html>, so the hero can fit the
 * first screen under it and the pinned assay can start below it. The header's padding scales with
 * the viewport, so a fixed number would be wrong on most screens. Scroll positions are measured
 * again whenever the height or the fonts change, since both move everything below.
 */
export function HeaderHeight(): null {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(`.${s.header}`);
    if (header === null) return;
    gsap.registerPlugin(ScrollTrigger);
    const root = document.documentElement;
    let last = -1;

    const measure = (): void => {
      const height = Math.round(header.getBoundingClientRect().height);
      if (height === last) return;
      const first = last === -1;
      last = height;
      root.style.setProperty("--header-h", `${height}px`);
      if (!first) ScrollTrigger.refresh();
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) ScrollTrigger.refresh();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
      root.style.removeProperty("--header-h");
    };
  }, []);

  return null;
}
