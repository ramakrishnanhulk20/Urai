"use client";

import { use, useId, useSyncExternalStore, type CSSProperties } from "react";
import s from "./docs.module.css";
import { ScrollRegion } from "./scroll-region";

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

/*
 * A name for the diagram a screen reader can announce, read from the chart's own source because
 * the docs never write a title for it: the participants of a sequence diagram, the groups of a
 * flowchart.
 */
export function diagramLabel(chart: string): string {
  const lines = chart.split("\n").map((l) => l.trim());
  const unquote = (v: string): string => v.replace(/^"|"$/g, "").replaceAll("<br/>", " ");
  if (lines.some((l) => l.startsWith("sequenceDiagram"))) {
    const names = lines.map((l) => /^participant\s+\S+\s+as\s+(.+)$/.exec(l)?.[1]).filter((v): v is string => v !== undefined);
    return names.length > 0 ? `Sequence diagram between ${names.join(", ")}` : "Sequence diagram";
  }
  const groups = lines
    .map((l) => /^subgraph\s+(\S+?)(?:\[(.+)\])?$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => unquote(m[2] ?? m[1]!));
  return groups.length > 0 ? `Diagram with groups: ${groups.join("; ")}` : "Diagram";
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
    <ScrollRegion as="figure" label={diagramLabel(chart)} className={s.diagram} style={style}>
      <div
        ref={(container) => {
          if (container) bindFunctions?.(container);
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </ScrollRegion>
  );
}
