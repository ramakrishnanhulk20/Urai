import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import { Mermaid } from "./mermaid";
import { ScrollRegion } from "./scroll-region";
import { SecurityRecord } from "./security-record";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function cellTexts(section: ReactNode): string[] {
  if (!isValidElement<{ children?: ReactNode }>(section)) return [];
  const row = Children.toArray(section.props.children).find(isValidElement);
  if (!isValidElement<{ children?: ReactNode }>(row)) return [];
  return Children.toArray(row.props.children).map((cell) => textOf(cell).trim());
}

/* A markdown table's column names, read from its header row. Empty header cells are skipped. */
export function tableLabel(children: ReactNode): string {
  const head = Children.toArray(children).find((c) => isValidElement(c) && c.type === "thead");
  const names = cellTexts(head).filter((name) => name !== "");
  return names.length > 0 ? `Table: ${names.join(", ")}` : "Table";
}

/* A code block's first two lines, so the blocks on one page have names a screen reader can tell apart. */
export function codeLabel(children: ReactNode): string {
  const lines = textOf(children)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const start = lines.slice(0, 2).join(", ");
  return start === "" ? "Code" : `Code: ${start.length > 80 ? `${start.slice(0, 80)}...` : start}`;
}

// Replaces Fumadocs' own wrapper, a plain scrolling div a keyboard could not reach.
function Table(props: ComponentProps<"table">) {
  return (
    <ScrollRegion label={tableLabel(props.children)}>
      <table {...props} />
    </ScrollRegion>
  );
}

// Fumadocs already makes a code block's scrolling box focusable; this gives that box a name.
function CodeBox(props: ComponentProps<"pre">) {
  return (
    <CodeBlock {...props} viewportProps={{ "aria-label": codeLabel(props.children) }}>
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    pre: CodeBox,
    table: Table,
    Mermaid,
    SecurityRecord,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
