"use client";

import { use, useId, useSyncExternalStore, type CSSProperties } from "react";
import s from "./docs.module.css";

export function Mermaid({ chart }: { chart: string }) {
  // Mermaid needs the DOM, so render nothing on the server and during hydration.
  const isClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  if (!isClient) return null;
  return <MermaidContent chart={chart} />;
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { default: mermaid } = use(cachePromise("mermaid", () => import("mermaid")));

  // Only the "base" theme accepts themeVariables, and Mermaid reads hex colours only.
  // Dagre is the classic layout GitHub uses, so the README and the docs draw the same diagrams.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    fontFamily: "inherit",
    themeCSS: "margin: 1.5rem auto 0;",
    theme: "base",
    layout: "dagre",
    themeVariables: {
      darkMode: true,
      background: "#0b0b0c",
      primaryColor: "#16140f",
      primaryTextColor: "#efe9df",
      primaryBorderColor: "#e2b04a",
      nodeBorder: "#e2b04a",
      secondaryColor: "#121214",
      tertiaryColor: "#0f0f11",
      lineColor: "#9c7226",
      textColor: "#efe9df",
      clusterBkg: "#0f0f11",
      edgeLabelBackground: "#0b0b0c",
      noteBkgColor: "#16140f",
    },
  });

  const { svg, bindFunctions } = use(
    cachePromise(chart, () => mermaid.render(id, chart)),
  );

  // The CSS needs the drawing's natural width so a phone can stop it shrinking past a readable size.
  const naturalWidth = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/.exec(svg)?.[1];
  const style = naturalWidth
    ? ({ "--natural-w": `${naturalWidth}px` } as CSSProperties)
    : undefined;

  return (
    <figure className={s.diagram} style={style}>
      <div
        ref={(container) => {
          if (container) bindFunctions?.(container);
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </figure>
  );
}
