// Server only: this reads the database. The server-only package is not installed, so nothing
// enforces it at build time; never import this file from a "use client" component.
import { CONFIG } from "./config";
import { HttpError, requireSharedRun } from "./http";
import { loadReport, type Report } from "./report";
import sampleReports from "./sample-reports.json";

export interface Sample {
  slug: string;
  title: string;
  reportId: string;
  report: Report;
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();
const lastGood = new Map<string, unknown>();

/*
 * A 404 is the database answering, not failing: the sample was unshared or has expired, so the old
 * copy must stop showing too. Anything else (a timeout, a dropped connection) says nothing new.
 */
function isAnswer(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

/**
 * Runs load at most once per CONFIG.sampleCacheSeconds for this name in this server instance
 * (C31): the landing page and /try read the same sample reports and workloads on every request,
 * and they never change once seeded. Callers that arrive while a load is running share it. When a
 * refresh fails, the last good value is served for another CONFIG.sampleCacheSeconds, so a brief
 * database fault never takes the landing page down; only a first-ever failure, or a 404 saying the
 * sample is gone, reaches the caller, and then the name is dropped so the next request tries again.
 * Only fixed names from lib/sample-reports.json and the /try sample list are passed here, so
 * neither map can grow.
 */
export function cachedSample<T>(name: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(name);
  if (hit !== undefined && now - hit.at < CONFIG.sampleCacheSeconds * 1000) return hit.value as Promise<T>;
  const value = load().then(
    (fresh) => {
      lastGood.set(name, fresh);
      return fresh;
    },
    (err: unknown) => {
      if (!isAnswer(err) && lastGood.has(name)) {
        console.warn(`[urai] sample ${name} refresh failed; serving the last good copy`);
        return lastGood.get(name) as T;
      }
      lastGood.delete(name);
      throw err;
    },
  );
  cache.set(name, { at: now, value });
  value.catch(() => {
    if (cache.get(name)?.value === value) cache.delete(name);
  });
  return value;
}

/*
 * Goes through the same lookup as the public report route, so a sample that was unshared or has
 * expired fails here too instead of showing numbers a visitor could not open themselves.
 */
function loadSample(entry: { slug: string; title: string; reportId: string }): Promise<Sample> {
  return cachedSample(`report:${entry.slug}`, async () => {
    const run = await requireSharedRun(entry.reportId);
    return { slug: entry.slug, title: entry.title, reportId: entry.reportId, report: await loadReport(run) };
  });
}

/** Every sample in lib/sample-reports.json with its full public report, read from the database at most once a minute. */
export async function getSampleReports(): Promise<Sample[]> {
  return Promise.all(sampleReports.map(loadSample));
}

/** One sample by slug, or null when the slug is not in lib/sample-reports.json. */
export async function getSample(slug: string): Promise<Sample | null> {
  const entry = sampleReports.find((s) => s.slug === slug);
  return entry === undefined ? null : loadSample(entry);
}
