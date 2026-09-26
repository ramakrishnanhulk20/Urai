"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import samples from "../../lib/sample-reports.json";
import s from "./report.module.css";

// The four sample runs in the order the story reads, under the short names the landing page uses.
const ORDER: { slug: string; label: string }[] = [
  { slug: "fix-before", label: "Before the fix" },
  { slug: "fix-after", label: "After the fix" },
  { slug: "parity", label: "Good layout" },
  { slug: "hard", label: "Hard set" },
];

const LINKS = ORDER.flatMap(({ slug, label }) => {
  const found = samples.find((x) => x.slug === slug);
  return found === undefined ? [] : [{ slug, label, reportId: found.reportId }];
});

/*
 * On one of the four sample reports, the other three are one click away, so a judge can walk the
 * whole story without going back to the landing page. Any other report shows nothing here.
 */
export function SampleSiblings() {
  const pathname = usePathname() ?? "";
  const current = LINKS.find((l) => pathname === `/r/${l.reportId}`);
  if (current === undefined) return null;

  return (
    <nav className={s.siblings} aria-label="The other sample reports">
      <p className={s.smallLabel}>Sample reports</p>
      <ol className={s.siblingList}>
        {LINKS.map((l) => (
          <li key={l.slug}>
            {l.slug === current.slug ? (
              <span className={s.siblingHere} aria-current="page">
                {l.label}
              </span>
            ) : (
              <Link href={`/r/${l.reportId}`} className={s.textLink}>
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
