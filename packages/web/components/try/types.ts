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

/** What SERV mode means to a visitor. raw is the model called directly, with SERV switched off. */
export function configLabel(config: { mode: string }): string {
  return config.mode === "raw" ? "SERV off" : `SERV ${config.mode}`;
}

// One decimal at most, with a trailing zero dropped: 0.675 reads 67.5 and 1 reads 100.
export function percent(accuracy: number): string {
  return String(Number((accuracy * 100).toFixed(1)));
}
