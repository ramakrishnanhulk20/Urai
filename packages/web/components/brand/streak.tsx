"use client";

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "../reduced-motion";
import b from "./brand.module.css";
import { seededRandom, valueNoise2D } from "./noise";

const DURATION_MS = 1400;
const START_DELAY_MS = 220;
const STEP_PX = 1.25;

interface Sample {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Where the streak starts, the point its curve bends toward, and where it ends, in pixels inside
 * the element that holds the streak. Width and height are that element's size.
 */
export type StreakAnchors = (root: HTMLElement, width: number, height: number) => [Point, Point, Point];

/** Layout position inside root, ignoring transforms, so entrance animations cannot skew it. */
export function offsetWithin(el: HTMLElement, root: HTMLElement): Point {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node !== null && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

/*
 * The default path. The streak lives in the open stone between the element marked
 * data-streak-ceiling and the one marked data-streak-floor, so it never runs under a word. On wide
 * screens it starts just above the element marked data-streak-from, as if rubbed off it. Without
 * those marks it falls back to a diagonal across the top of the root.
 */
export const anchorsBetweenMarks: StreakAnchors = (root, w, h) => {
  const ceilingEl = root.querySelector<HTMLElement>("[data-streak-ceiling]");
  const floorEl = root.querySelector<HTMLElement>("[data-streak-floor]");
  const fromEl = root.querySelector<HTMLElement>("[data-streak-from]");
  const ceiling = ceilingEl ? offsetWithin(ceilingEl, root).y + ceilingEl.offsetHeight + h * 0.05 : h * 0.1;
  let floor = floorEl ? offsetWithin(floorEl, root).y - 18 : h * 0.4;
  // A short screen leaves little open stone; the streak then dips toward the text rather than going flat.
  floor = Math.max(floor, ceiling + h * 0.2);

  const portrait = h > w;
  const startX = portrait || fromEl === null ? w * 0.05 : offsetWithin(fromEl, root).x + fromEl.offsetWidth * 0.08;
  const p0 = { x: startX, y: floor };
  const p2 = { x: w * (portrait ? 0.97 : 0.95), y: ceiling };
  const p1 = { x: p0.x + (p2.x - p0.x) * 0.55, y: p0.y + (p2.y - p0.y) * 0.22 };
  return [p0, p1, p2];
};

/*
 * The streak follows a gently sagging diagonal, resampled to even spacing so the brush lays the
 * same amount of gold per pixel whether the curve is steep or flat.
 */
function buildPath([p0, p1, p2]: [Point, Point, Point]): Sample[] {
  const at = (t: number) => {
    const m = 1 - t;
    return { x: m * m * p0.x + 2 * m * t * p1.x + t * t * p2.x, y: m * m * p0.y + 2 * m * t * p1.y + t * t * p2.y };
  };

  const dense: { x: number; y: number; d: number }[] = [];
  let d = 0;
  let prev = at(0);
  for (let i = 0; i <= 2000; i++) {
    const p = at(i / 2000);
    d += Math.hypot(p.x - prev.x, p.y - prev.y);
    dense.push({ ...p, d });
    prev = p;
  }

  const out: Sample[] = [];
  let j = 1;
  for (let dist = 0; dist <= d; dist += STEP_PX) {
    while (j < dense.length - 1 && dense[j]!.d < dist) j++;
    const a = dense[j - 1]!;
    const b = dense[j]!;
    const f = b.d === a.d ? 0 : (dist - a.d) / (b.d - a.d);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, nx: -(b.y - a.y) / len, ny: (b.x - a.x) / len });
  }
  return out;
}

// Gold from shadow to glint. The light side of the streak gets the paler entries.
const GOLDS = ["#8f6620", "#b3842c", "#cf9d3c", "#e2b04a", "#ecc266", "#f4d58c", "#fbe8b6"];

interface Brush {
  path: Sample[];
  width: number;
  lanes: number;
  lane: (lane: number, u: number) => number;
  rand: () => number;
}

function makeBrush(anchors: StreakAnchors, root: HTMLElement, w: number, h: number): Brush {
  const width = Math.min(72, Math.max(24, w * 0.046));
  return {
    path: buildPath(anchors(root, w, h)),
    width,
    lanes: Math.round(width / 1.3),
    lane: valueNoise2D(11),
    rand: seededRandom(29),
  };
}

/*
 * Lays gold along samples [from, to). Each sample is crossed by parallel lanes, and each lane
 * skips where the stone's grain would have caught nothing, which is what gives a rubbed streak
 * its fine striations instead of a flat painted line.
 */
function rub(ctx: CanvasRenderingContext2D, brush: Brush, from: number, to: number, dpr: number): void {
  const { path, width, lanes, lane, rand } = brush;
  const total = path.length - 1;
  for (let k = from; k < to && k <= total; k++) {
    const p = path[k]!;
    // Draw in the brush's own frame (x along the stroke, y across it) so each grain is a short dash.
    ctx.setTransform(dpr * p.ny, -dpr * p.nx, dpr * p.nx, dpr * p.ny, dpr * p.x, dpr * p.y);
    const u = k / total;
    const taper = Math.pow(Math.min(1, u / 0.07), 0.55) * Math.pow(Math.min(1, (1 - u) / 0.16), 0.8);
    const pressure = 0.9 + 0.1 * Math.sin(u * 19) + 0.06 * Math.sin(u * 53);
    const halfW = (width / 2) * taper * pressure;
    for (let j = 0; j < lanes; j++) {
      const across = -1 + (2 * (j + 0.5)) / lanes;
      const off = across * (width / 2);
      if (Math.abs(off) > halfW) continue;
      const edge = 1 - Math.pow(Math.abs(off) / halfW, 4);
      const density = (0.52 + lane(k / 34 + j * 7.1, j * 3.3) * 0.75) * edge;
      if (rand() > density) continue;
      const shade = Math.min(GOLDS.length - 1, Math.max(0, Math.round((1 - across) * 2.4 + rand() * 2.2)));
      ctx.globalAlpha = 0.3 + rand() * 0.5;
      ctx.fillStyle = rand() < 0.012 ? "#fff6dc" : GOLDS[shade]!;
      ctx.fillRect((rand() - 0.5) * 2, off + (rand() - 0.5) * 0.8, 1.5 + rand() * 3.5, 0.8 + rand() * 0.7);
    }
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
}

export interface StreakProps {
  /** The path to rub along, measured against the streak's parent element. */
  anchors?: StreakAnchors;
  /** Extra class on the streak layer, for a page's own parallax or placement. */
  className?: string;
}

/*
 * The gold streak rubbed across the stone on load, with a little dust that drifts off it. It fills
 * its parent, which must be positioned. With reduced motion the rub is skipped and the finished
 * streak is drawn in one go.
 */
export function Streak({ anchors = anchorsBetweenMarks, className }: StreakProps) {
  const trailRef = useRef<HTMLCanvasElement>(null);
  const dustRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();
  // Held in a ref so a page passing a fresh function each render does not restart the rub.
  const anchorsRef = useRef(anchors);

  useEffect(() => {
    anchorsRef.current = anchors;
  });

  useEffect(() => {
    const trail = trailRef.current;
    const dust = dustRef.current;
    const host = trail?.parentElement;
    const root = host?.parentElement;
    if (!trail || !dust || !host || !root) return;
    const tctx = trail.getContext("2d");
    const dctx = dust.getContext("2d");
    if (!tctx || !dctx) return;

    let raf = 0;
    let delay = 0;
    let cancelled = false;
    let resizeTimer = 0;
    let lastWidth = 0;

    let dpr = 1;
    const size = (): { w: number; h: number } => {
      const rect = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const c of [trail, dust]) {
        c.width = Math.round(rect.width * dpr);
        c.height = Math.round(rect.height * dpr);
      }
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastWidth = rect.width;
      return { w: rect.width, h: rect.height };
    };

    const drawFinal = (): void => {
      window.cancelAnimationFrame(raf);
      const { w, h } = size();
      const brush = makeBrush(anchorsRef.current, root, w, h);
      rub(tctx, brush, 0, brush.path.length, dpr);
      trail.dataset.done = "true";
    };

    const animate = (): void => {
      const { w, h } = size();
      const brush = makeBrush(anchorsRef.current, root, w, h);
      const motes: Mote[] = [];
      const dustRand = seededRandom(41);
      let drawn = 0;
      let start = 0;
      let last = 0;

      const frame = (now: number): void => {
        if (start === 0) {
          start = now;
          last = now;
        }
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const t = Math.min(1, (now - start) / DURATION_MS);
        // A hand rubbing a stone starts slow, sweeps, and eases off at the end.
        const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
        const target = Math.round(eased * (brush.path.length - 1));
        if (target > drawn) {
          rub(tctx, brush, drawn, target + 1, dpr);
          drawn = target + 1;
          const head = brush.path[Math.min(target, brush.path.length - 1)]!;
          const spawn = t < 1 ? 1 + Math.floor(dustRand() * 3) : 0;
          for (let i = 0; i < spawn; i++) {
            const across = (dustRand() - 0.5) * brush.width;
            motes.push({
              x: head.x + head.nx * across,
              y: head.y + head.ny * across,
              vx: (dustRand() - 0.5) * 34,
              vy: -10 - dustRand() * 30,
              age: 0,
              life: 0.8 + dustRand() * 0.9,
              size: 0.9 + dustRand() * 1.8,
            });
          }
        }

        dctx.clearRect(0, 0, w, h);
        // A warm glow where the metal meets the stone, which also softens the flat leading edge.
        if (t < 1) {
          const head = brush.path[Math.min(drawn, brush.path.length - 1)]!;
          const r = brush.width * 1.1;
          const glow = dctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, r);
          glow.addColorStop(0, "rgba(255, 230, 170, 0.55)");
          glow.addColorStop(0.4, "rgba(226, 176, 74, 0.22)");
          glow.addColorStop(1, "rgba(226, 176, 74, 0)");
          dctx.globalAlpha = Math.min(1, (1 - t) / 0.15);
          dctx.fillStyle = glow;
          dctx.fillRect(head.x - r, head.y - r, r * 2, r * 2);
          dctx.globalAlpha = 1;
        }
        for (const m of motes) {
          m.age += dt;
          if (m.age >= m.life) continue;
          m.vy += 14 * dt;
          m.vx *= 0.985;
          m.x += m.vx * dt;
          m.y += m.vy * dt;
          dctx.globalAlpha = Math.pow(1 - m.age / m.life, 1.6) * 0.85;
          dctx.fillStyle = "#f4d58c";
          dctx.fillRect(m.x, m.y, m.size, m.size);
        }
        dctx.globalAlpha = 1;

        const settled = t >= 1 && motes.every((m) => m.age >= m.life);
        if (!settled) {
          raf = window.requestAnimationFrame(frame);
        } else {
          dctx.clearRect(0, 0, w, h);
          trail.dataset.done = "true";
        }
      };
      raf = window.requestAnimationFrame(frame);
    };

    // The path is measured off the headline, so it waits for the real font, but never for long.
    const fontsSettled = Promise.race([document.fonts.ready, new Promise((done) => window.setTimeout(done, 700))]);
    void fontsSettled.then(() => {
      if (cancelled) return;
      if (reduced) drawFinal();
      else delay = window.setTimeout(animate, START_DELAY_MS);
    });

    const onResize = (): void => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (Math.abs(host.getBoundingClientRect().width - lastWidth) < 1) return;
        window.clearTimeout(delay);
        dctx.clearRect(0, 0, dust.width, dust.height);
        drawFinal();
      }, 160);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.clearTimeout(delay);
      window.clearTimeout(resizeTimer);
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [reduced]);

  return (
    <div className={className ? `${b.streak} ${className}` : b.streak} aria-hidden="true">
      <canvas ref={trailRef} className={b.streakCanvas} />
      <canvas ref={dustRef} className={b.streakCanvas} />
    </div>
  );
}
