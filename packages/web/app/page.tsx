import Link from "next/link";
import { connection } from "next/server";
import { Stone } from "../components/brand/stone";
import { AssayBeat } from "../components/landing/assay-beat";
import { FinalCall } from "../components/landing/final-call";
import { HeaderHeight } from "../components/landing/header-height";
import { Hero } from "../components/landing/hero";
import { HowItWorks } from "../components/landing/how-it-works";
import { KeySection } from "../components/landing/key-section";
import l from "../components/landing/landing.module.css";
import { Ledger } from "../components/landing/ledger";
import { SetupCheck } from "../components/landing/setup-check";
import { Footer } from "../components/site/footer";
import { Header } from "../components/site/header";
import { SmoothScroll } from "../components/smooth-scroll";
import { getLandingData } from "../lib/landing-data";

export default async function Home() {
  // Every number here is read from the sample reports on each request, never frozen into the build.
  await connection();
  const data = await getLandingData();

  return (
    <div className={l.root}>
      <SmoothScroll />
      <HeaderHeight />
      {/* The hero rubs its own streak, measured off its headline. */}
      <Stone streak={false} />
      <Header />
      <main>
        <Hero
          {...data.hero}
          headerOffset="var(--header-h, 72px)"
          afterActions={
            <Link href="/try" className={l.demoLink}>
              <span>or run the live demo, no key needed</span>
              <span className={l.demoArrow} aria-hidden="true">
                &rarr;
              </span>
            </Link>
          }
        />
        <AssayBeat {...data.assay} headerVar="--header-h" className={l.beatPin} />
        <HowItWorks data={data.how} />
        <SetupCheck data={data.setup} />
        <Ledger data={data.ledger} />
        <KeySection security={data.security} />
        <FinalCall />
      </main>
      <Footer />
    </div>
  );
}
