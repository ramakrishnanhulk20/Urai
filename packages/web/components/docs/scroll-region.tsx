"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import s from "./docs.module.css";

export interface ScrollRegionProps {
  label: string;
  as?: "div" | "figure";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/*
 * A box that scrolls sideways on its own when its content is wider than the column. It takes
 * keyboard focus, so arrow keys can scroll it without a mouse, and a quiet hint shows under it only
 * while part of it is out of view. The hint sits outside the scrolling box so it never scrolls away.
 */
export function ScrollRegion({ label, as = "div", className, style, children }: ScrollRegionProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [section, setSection] = useState<string | null>(null);

  // Two tables on one page can share their columns, so the name also says which section holds it.
  useEffect(() => {
    let node: Element | null = ref.current?.parentElement ?? null;
    while (node !== null && !node.matches("article, main, body")) {
      let prev = node.previousElementSibling;
      while (prev !== null && !/^H[1-6]$/.test(prev.tagName)) prev = prev.previousElementSibling;
      if (prev !== null) {
        setSection(prev.textContent?.trim() || null);
        return;
      }
      node = node.parentElement;
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // One pixel of slack, because a fractional width can leave scrollWidth a hair over clientWidth.
    const check = (): void => setOverflow(el.scrollWidth - el.clientWidth > 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  const Tag = as;
  return (
    <div className={s.scrollWrap}>
      <Tag
        ref={(node: HTMLElement | null) => {
          ref.current = node;
        }}
        className={`${s.scroller} ${className ?? ""}`}
        style={style}
        role="region"
        tabIndex={0}
        aria-label={section === null ? label : `${label}, under ${section}`}
        data-overflow={overflow}
      >
        {children}
      </Tag>
      {overflow && (
        <p className={s.scrollHint} aria-hidden="true">
          Scroll sideways <span className={s.scrollArrow}>&rarr;</span>
        </p>
      )}
    </div>
  );
}
