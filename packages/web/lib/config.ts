import { LIMITS } from "@urai/engine";

/**
 * Every number the web server enforces (threat model C26). Engine caps are re-exported from the
 * engine's LIMITS so the two can never drift apart. Nothing else under packages/web may hardcode
 * one of these values. The daily demo budget lives in the environment (lib/env.ts), because the
 * operator sets it per deployment.
 */
export const CONFIG = {
  upstreamTimeoutMs: LIMITS.upstreamTimeoutMs,
  // Tighter than the engine's per-field caps allow in total, on purpose: 100 cases at the full
  // 30,000 characters each would not fit. Our 40-case invoice samples are 68 KB to 111 KB.
  bodyMaxBytes: 300 * 1024,
  casesPerWorkloadMax: LIMITS.casesMax,
  configsPerRunMax: LIMITS.configsPerRunMax,
  concurrentCaseCallsPerRun: 4,
  // 16 bytes is 128 bits, the floor C8 sets for every public id.
  idBytes: 16,
  ownerTokenBytes: 32,
  workloadRetentionDays: 30,
  rateWindowSeconds: 3_600,
  workloadsPerIpPerWindow: 20,
  runsPerIpPerWindow: 40,
  // The lint is free to run and the editor calls it as the user types, so it gets a wider bucket.
  lintPerIpPerWindow: 60,
  // A public report read compiles the schema and lints the stored workload (C31).
  reportPerIpPerWindow: 120,
  // Team calls SERV refused with 401 or 402, per address (C33). One mistyped key costs at most 4
  // refusals, because a run has at most 4 calls in flight, so a real team never comes near 30.
  keyRefusalsPerIpPerWindow: 30,
  // Sample reports and workloads never change once seeded, so each server instance keeps them this long (C31).
  sampleCacheSeconds: 60,
  // A lint 400 lists the engine's reasons, capped in count and length (C14).
  lintReasonsMax: 20,
  lintReasonMaxChars: 200,
  // The cached SERV model list is trusted for this long, then refetched (C18).
  modelCacheMaxAgeSeconds: 3_600,
  // After a failed refresh, SERV is not asked again for this long, so an outage does not add a
  // slow upstream call to every picker load and lint.
  modelFailureBackoffSeconds: 60,
  // Rate-limit windows are one hour, so anything two days old can never be counted again.
  rateLimitRetentionDays: 2,
  demoBudgetRetentionDays: 30,
  // Demo runs sit on samples, which never expire, so without this their results would pile up forever.
  demoRunRetentionDays: 7,
  // Vercel asks for at least 16; a shorter CRON_SECRET is treated as missing and every cron call is refused.
  cronSecretMinChars: 32,
  // Sample ids are chosen by the operator and are not secrets; every other id comes from newId().
  workloadIdMaxChars: 64,
  // A demo run on a 40-case sample is cut to its first 12 cases, so one run costs the operator little.
  demoCasesMax: 12,
  // Reserved from the daily demo budget before each demo call, then swapped for the real cost.
  // A gpt-6-luna call on the invoice samples costs well under a tenth of this.
  demoCallEstimateUsd: 0.01,
  // demo_budget stores numeric(10,4); real costs are rounded up to this many places, never down.
  budgetUsdPlaces: 4,
  // Upstream timeout (120 s) plus the connect retries (7 s) plus margin. A claim older than this
  // belongs to a call that died.
  claimStaleSeconds: 150,
  // Report caps (C29). Each text cap holds as characters and as UTF-8 bytes once JSON-escaped, so
  // a report of 100 cases x 6 settings at every cap measures 2.7 MB, plus at most bodyMaxBytes of
  // uncut workload fields (expected values, schema), under reportResponseMaxBytes.
  reportTextMaxChars: 2_000,
  // An answer object longer than this once serialised is replaced by { truncated: true, chars }.
  reportAnswerMaxChars: 2_000,
  reportPromptMaxChars: 20_000,
  reportResponseMaxBytes: 4_000_000,
  statusResponseMaxBytes: 4_000_000,
} as const satisfies { readonly [k: string]: number };

/** A custom header, so a cross-site form can never send it without a CORS preflight we refuse (C22). */
export const OWNER_HEADER = "x-urai-owner";
