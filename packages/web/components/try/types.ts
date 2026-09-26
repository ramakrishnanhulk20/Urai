/*
 * Shapes the server page hands to the client demo. Kept free of any server import so the client
 * bundle never pulls in the database code behind lib/samples.ts.
 */

export type DemoMode = "raw" | "plain" | "guard" | "multipath" | "full";

export interface DemoConfig {
  model: string;
  mode: DemoMode;
  keepContentFilter?: boolean;
}

export interface SavedColumn {
  label: string;
  accuracy: number;
  correct: number;
  calls: number;
}

export interface SavedResult {
  reportId: string;
  title: string;
  cases: number;
  columns: SavedColumn[];
}

export interface SampleChoice {
  workloadId: string;
  name: string;
  line: string;
  /** The settings this sample allows for a demo run, read from its allowlist in the database. */
  configs: DemoConfig[];
  /** Case id to the expected verdict, from the sample workload itself. Empty when it could not be read. */
  expected: Record<string, string>;
  /** The saved full-run report for this sample, or null when it could not be loaded. */
  saved: SavedResult | null;
}

const MODE_LABELS: Record<string, string> = {
  raw: "SERV off",
  plain: "SERV plain",
  guard: "SERV with PromptGuard",
  multipath: "SERV Multipath",
  full: "SERV full",
};

/*
 * What each setting means to a visitor, the same words the report uses. raw is the model called
 * directly, with SERV switched off. Plain reads "SERV on" when it is the only SERV mode in the
 * list; Multipath, PromptGuard and full keep their names, since "SERV on" would hide what else was
 * switched on. With more than one model, each label leads with its model.
 */
export function configLabels(configs: { mode: string; model?: string }[]): string[] {
  const single = new Set(configs.filter((c) => c.mode !== "raw").map((c) => c.mode)).size <= 1;
  const base = configs.map((c) => (single && c.mode === "plain" ? "SERV on" : (MODE_LABELS[c.mode] ?? `SERV ${c.mode}`)));
  const models = new Set(configs.map((c) => (c.model ?? "").trim().toLowerCase()));
  return models.size > 1 ? base.map((label, i) => `${configs[i]!.model ?? ""}, ${label}`) : base;
}

/** Defines "plain" when it is named next to another SERV mode. Null when no mode is named. */
export function modeNote(configs: { mode: string }[]): string | null {
  const modes = new Set(configs.filter((c) => c.mode !== "raw").map((c) => c.mode));
  return modes.size > 1 && modes.has("plain") ? "SERV plain means SERV's reasoning on, with its output filter off (Urai always switches it off so answers that quote the rules are not cut), nothing else added." : null;
}

// One decimal at most, with a trailing zero dropped: 0.675 reads 67.5 and 1 reads 100.
export function percent(accuracy: number): string {
  return String(Number((accuracy * 100).toFixed(1)));
}
