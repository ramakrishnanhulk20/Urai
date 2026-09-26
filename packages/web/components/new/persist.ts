import type { ServMode } from "@urai/engine";
import { EMPTY_COMPARE, MODES, nextRowKey, type Compare, type Draft, type SampleEntry, type ScoreRow } from "./draft";

/*
 * The builder's fields, kept for this tab only so a reload or a trip to the docs does not wipe a
 * half-written test set. The SERV key is not in this shape and is never passed here: it stays in
 * the page's memory alone (C22). sessionStorage dies with the tab.
 */
const FORM_KEY = "urai.new.form";

export interface SavedForm {
  draft: Draft;
  loaded: SampleEntry["slug"] | null;
  model: string;
  modes: ServMode[];
  compare: Compare;
}

const RULES: readonly string[] = ["exact", "oneOf", "number"];
const SLUGS: readonly string[] = ["bad", "good", "hard"];
const MODE_IDS: readonly string[] = MODES.map((m) => m.mode);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Only what the form itself would have typed: every field is rebuilt by hand, never spread from storage.
function toForm(v: unknown): SavedForm | null {
  if (!isRecord(v) || !isRecord(v.draft)) return null;
  const d = v.draft;
  const text = ["name", "systemPrompt", "context", "schemaText", "casesText"] as const;
  if (!text.every((k) => typeof d[k] === "string")) return null;
  if (d.shadowHint !== null && typeof d.shadowHint !== "string") return null;
  if (!Array.isArray(d.scoring)) return null;
  const scoring: ScoreRow[] = [];
  for (const r of d.scoring) {
    if (!isRecord(r) || typeof r.field !== "string" || typeof r.rule !== "string" || !RULES.includes(r.rule) || typeof r.tolerance !== "string") {
      return null;
    }
    scoring.push({ key: nextRowKey(), field: r.field, rule: r.rule as ScoreRow["rule"], tolerance: r.tolerance });
  }
  const loaded = typeof v.loaded === "string" && SLUGS.includes(v.loaded) ? (v.loaded as SampleEntry["slug"]) : null;
  const modes = Array.isArray(v.modes) ? (v.modes.filter((m) => typeof m === "string" && MODE_IDS.includes(m)) as ServMode[]) : [];
  // A form saved before the second model existed has no compare field; it reads as none.
  const c: Record<string, unknown> = isRecord(v.compare) ? v.compare : {};
  const compare: Compare =
    typeof c.model === "string"
      ? { model: c.model, mode: typeof c.mode === "string" && MODE_IDS.includes(c.mode) ? (c.mode as ServMode) : EMPTY_COMPARE.mode }
      : EMPTY_COMPARE;
  return {
    draft: {
      name: d.name as string,
      systemPrompt: d.systemPrompt as string,
      context: d.context as string,
      schemaText: d.schemaText as string,
      casesText: d.casesText as string,
      shadowHint: d.shadowHint as string | null,
      scoring,
    },
    loaded,
    model: typeof v.model === "string" ? v.model : "",
    modes,
    compare,
  };
}

export function saveForm(form: SavedForm): void {
  const { draft, loaded, model, modes, compare } = form;
  const stored = {
    draft: {
      name: draft.name,
      systemPrompt: draft.systemPrompt,
      context: draft.context,
      schemaText: draft.schemaText,
      casesText: draft.casesText,
      shadowHint: draft.shadowHint,
      scoring: draft.scoring.map((r) => ({ field: r.field, rule: r.rule, tolerance: r.tolerance })),
    },
    loaded,
    model,
    modes,
    compare: { model: compare.model, mode: compare.mode },
  };
  try {
    sessionStorage.setItem(FORM_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or switched off: the form still works, it just will not survive a reload.
  }
}

export function loadForm(): SavedForm | null {
  try {
    const raw = sessionStorage.getItem(FORM_KEY);
    return raw === null ? null : toForm(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** True once anything has been typed or loaded, which is when leaving the page would lose work. */
export function draftHasInput(d: Draft): boolean {
  return [d.name, d.systemPrompt, d.context, d.schemaText, d.casesText].some((t) => t.trim() !== "") || d.scoring.length > 0;
}
