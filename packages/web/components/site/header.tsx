"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import b from "../brand/brand.module.css";
import { Slash } from "../brand/slash";
import s from "./site.module.css";

const LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/#reports", label: "Sample reports" },
  { href: "/try", label: "Live demo" },
  { href: "/docs", label: "Docs" },
] as const;

// Must match the breakpoint in site.module.css where the inline nav replaces the menu button.
const WIDE_QUERY = "(min-width: 960px)";

function isCurrent(pathname: string, href: string): boolean {
  if (href.includes("#")) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/*
 * The site header. It sits straight on the stone with no bar; once the page scrolls it gains a
 * soft blurred backdrop that fades out at its lower edge, so there is never a hard line.
 */
export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    let raf = 0;
    const check = (): void => {
      raf = 0;
      setScrolled(window.scrollY > 8);
    };
    const onScroll = (): void => {
      if (raf === 0) raf = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("a")?.focus();

    // Tab cycles between the menu button and the panel, since the page behind is covered.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      if (event.key !== "Tab" || panel === null || buttonRef.current === null) return;
      const stops = [buttonRef.current, ...panel.querySelectorAll<HTMLElement>("a")];
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : at === stops.length - 1 ? 0 : at + 1;
      event.preventDefault();
      stops[next]?.focus();
    };
    // Widening past the breakpoint hides the panel, so it must not stay open behind the scenes.
    const wide = window.matchMedia(WIDE_QUERY);
    const onWide = (): void => {
      if (wide.matches) close(false);
    };

    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      document.documentElement.style.removeProperty("overflow");
    };
  }, [open, close]);

  return (
    <header className={s.header} data-scrolled={scrolled || open} data-open={open}>
      <div className={s.bar}>
        <Link href="/" className={s.home} aria-label="Urai, home" onClick={() => close(false)}>
          <Slash wordmark />
        </Link>

        <nav className={s.nav} aria-label="Main">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={s.navLink}
              aria-current={isCurrent(pathname, link.href) ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <Link href="/new" className={`${b.goldButton} ${s.cta}`}>
          <span>Test your agent</span>
          <span className={b.goldArrow} aria-hidden="true">
            &rarr;
          </span>
        </Link>

        <button
          ref={buttonRef}
          type="button"
          className={s.menuButton}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((was) => !was)}
        >
          <span className={s.menuLabel}>{open ? "Close" : "Menu"}</span>
          <span className={s.menuIcon} aria-hidden="true">
            <span />
            <span />
          </span>
        </button>
      </div>

      <div ref={panelRef} id={panelId} className={s.panel} hidden={!open} data-lenis-prevent>
        <nav aria-label="Main">
          <ol className={s.panelList}>
            {LINKS.map((link, i) => (
              <li key={link.href} style={{ "--i": i } as CSSProperties}>
                <Link
                  href={link.href}
                  className={s.panelLink}
                  aria-current={isCurrent(pathname, link.href) ? "page" : undefined}
                  onClick={() => close(false)}
                >
                  <span className={s.panelIndex} aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{link.label}</span>
                  <Slash className={s.panelSlash} />
                </Link>
              </li>
            ))}
          </ol>
        </nav>
        <Link
          href="/new"
          className={`${b.goldButton} ${s.panelCta}`}
          style={{ "--i": LINKS.length } as CSSProperties}
          onClick={() => close(false)}
        >
          <span>Test your agent</span>
          <span className={b.goldArrow} aria-hidden="true">
            &rarr;
          </span>
        </Link>
      </div>
    </header>
  );
}
