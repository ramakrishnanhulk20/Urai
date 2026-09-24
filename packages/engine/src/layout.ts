import { scanDataBlocks } from "./lint.js";
import type { Workload } from "./types.js";
import { parseWorkload } from "./workload.js";

/**
 * The one-click rewrite: moves every data block that findDataBlocks finds out of the system
 * prompt and into context, where it travels in the user message. Each block goes with its
 * heading line and one blank line next to it, so the text left behind is exactly the text that
 * was around it. Each moved block is appended to context as "<heading or DATA>\n<block>", joined
 * with a blank line after any existing context. Nothing else changes.
 * Pure: works on a deep copy and never mutates w (C21). The result is checked with
 * parseWorkload before it is returned.
 * Throws when the data check cannot run (see findDataBlocks), or when the rewritten workload
 * would not pass parseWorkload, for example a context pushed over LIMITS.contextMaxChars or a
 * system prompt that was nothing but data.
 */
export function applyLayoutFix(w: Workload): { workload: Workload; moved: { heading: string | null; kind: string; chars: number }[] } {
  const copy = structuredClone(w);
  const { lines, blocks } = scanDataBlocks(copy.systemPrompt);

  const removed = new Array<boolean>(lines.length).fill(false);
  const blank = (i: number) => i >= 0 && i < lines.length && !removed[i] && lines[i]!.text.trim() === "";
  for (const b of blocks) {
    const top = b.headingLine ?? b.first;
    for (let i = top; i <= b.last; i++) removed[i] = true;
    if (blank(top - 1)) removed[top - 1] = true;
    else if (blank(b.last + 1)) removed[b.last + 1] = true;
  }

  const moved = blocks.map((b) => ({ heading: b.heading, kind: b.kind, chars: b.end - b.start }));
  const movedText = blocks.map((b) => `${b.heading ?? "DATA"}\n${copy.systemPrompt.slice(b.start, b.end)}`);
  const systemPrompt = blocks.length === 0 ? copy.systemPrompt : lines.filter((_, i) => !removed[i]).map((l) => l.text).join("\n");
  const context = blocks.length === 0 ? copy.context : [copy.context, ...movedText].filter((s): s is string => s !== null && s !== "").join("\n\n");

  const parsed = parseWorkload({ ...copy, systemPrompt, context });
  if (!parsed.ok) throw new Error(`applyLayoutFix: the rewritten workload is not valid: ${parsed.errors.join("; ")}`);
  return { workload: parsed.workload, moved };
}
