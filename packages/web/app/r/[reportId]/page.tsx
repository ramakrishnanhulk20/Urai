import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { Stone } from "../../../components/brand/stone";
import { Disagreements } from "../../../components/report/disagreements";
import { EveryCase } from "../../../components/report/every-case";
import { Findings } from "../../../components/report/findings";
import s from "../../../components/report/report.module.css";
import { ReportSummary } from "../../../components/report/summary";
import { Verdict } from "../../../components/report/verdict";
import { WhatIsThis } from "../../../components/report/what-is-this";
import { Footer } from "../../../components/site/footer";
import { Header } from "../../../components/site/header";
import { SmoothScroll } from "../../../components/smooth-scroll";
import { serverEnv } from "../../../lib/env";
import { HttpError, requireSharedRun } from "../../../lib/http";
import { ipHash } from "../../../lib/ip";
import { enforceRateLimit } from "../../../lib/rate";
import { loadReport, type Report } from "../../../lib/report";

export const maxDuration = 60;

type Params = Promise<{ reportId: string }>;

/*
 * The same lookups as GET /api/reports/[reportId], in the same order: a report that was never
 * shared, was unshared, has expired or does not exist is the not-found page, never a partial one
 * (C9, C30). Any other failure, such as a report over the size cap (C29), is thrown as an error.
 * Wrapped in cache() so the title and the page share one database read per request.
 */
const getReport = cache(async (reportId: string): Promise<Report | "rate_limited"> => {
  // Read on every request, so an unshare takes effect at once and no report is frozen into a build.
  await connection();
  serverEnv();
  try {
    // The page does the same schema compile and lint as the API route, so it shares that route's
    // per-address limit (C31); cache() makes the title and the body count as one view.
    await enforceRateLimit("report", ipHash(new Request("http://urai.local/", { headers: await headers() })));
    return await loadReport(await requireSharedRun(reportId));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    if (err instanceof HttpError && err.status === 429) return "rate_limited";
    throw err;
  }
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { reportId } = await params;
  const report = await getReport(reportId);
  return {
    title: report === "rate_limited" ? "Too many report views" : report.name,
    // A report link is a secret the owner chose to hand out, not a page for search engines to list.
    robots: { index: false, follow: false },
  };
}

export default async function ReportPage({ params }: { params: Params }) {
  const { reportId } = await params;
  const report = await getReport(reportId);

  if (report === "rate_limited") {
    return (
      <div className={s.root}>
        <Stone streak={false} />
        <Header />
        <main className={s.content}>
          <h1>Too many report views from your network this hour.</h1>
          <p>Reports are limited per address to keep the site fast for everyone. Try this link again in an hour.</p>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className={s.root}>
      <SmoothScroll />
      <Stone streak={false} />
      <Header />
      <main className={s.content}>
        <div className={s.opening}>
          <ReportSummary report={report} />
          <WhatIsThis />
        </div>
        <Verdict report={report} />
        <Disagreements report={report} />
        <Findings report={report} />
        <EveryCase report={report} />
      </main>
      <Footer />
    </div>
  );
}
