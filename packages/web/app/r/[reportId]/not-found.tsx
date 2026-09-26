import Link from "next/link";
import b from "../../../components/brand/brand.module.css";
import { Slash } from "../../../components/brand/slash";
import { Stone } from "../../../components/brand/stone";
import s from "../../../components/report/report.module.css";
import { Footer } from "../../../components/site/footer";
import { Header } from "../../../components/site/header";

/*
 * One answer for every missing report: never shared, taken back, expired or never existed. The
 * page does not say which, so a stranger guessing ids learns nothing (C9, C30).
 */
export default function ReportNotFound() {
  return (
    <div className={s.root}>
      {/* Next.js takes no metadata export from a not-found page, and generateMetadata stops at the same missing report, so the tab title is set here. */}
      <title>Report not found | Urai</title>
      <Stone streak={false} />
      <Header />
      <main className={s.content}>
        <section className={s.opening} aria-labelledby="missing-title">
          <div className={s.summary}>
            <p className={`${s.marker} ${s.enter}`}>
              <Slash className={s.markerSlash} />
              <span>Report not found</span>
            </p>
            <h1 id="missing-title" className={s.title} data-size="short">
              <span className={s.titleLine}>
                <span className={s.rise}>No report here</span>
              </span>
            </h1>
            <p className={`${s.sentence} ${s.enter}`}>
              This link does not lead to a shared report. It may have been mistyped, its owner may have made it private
              again, or its data may have passed its retention date.
            </p>
            <p className={`${s.whatLinks} ${s.enter}`}>
              <Link href="/#reports" className={b.goldButton}>
                <span>Open a sample report</span>
                <span className={b.goldArrow} aria-hidden="true">
                  &rarr;
                </span>
              </Link>
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
