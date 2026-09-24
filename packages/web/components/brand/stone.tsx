"use client";

import { useEffect, useRef } from "react";
import b from "./brand.module.css";
import { fractalNoise2D, seededRandom } from "./noise";
import { Streak, type StreakProps } from "./streak";

// A tile of film grain. Tiled from a small SVG rather than filtering the whole screen, which keeps
// scrolling cheap on phones.
const GRAIN_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'>" +
  "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/>" +
  "<feColorMatrix type='saturate' values='0'/></filter>" +
  "<rect width='100%' height='100%' filter='url(#g)'/></svg>";
const GRAIN_URL = `url("data:image/svg+xml,${encodeURIComponent(GRAIN_SVG)}")`;

/*
 * Paints the touchstone: soft fractal shading, faint quartz veins and fine mineral speckle.
 * The noise is computed at half size and scaled up, which is invisible under the grain and is
 * what keeps the first paint in the tens of milliseconds instead of hundreds.
 */
function paintStone(canvas: HTMLCanvasElement, width: number, height: number): void {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  const half = document.createElement("canvas");
  const hw = Math.ceil(width / 2);
  const hh = Math.ceil(height / 2);
  half.width = hw;
  half.height = hh;
  const hctx = half.getContext("2d");
  if (hctx === null) return;

  const shade = fractalNoise2D(7, 5);
  const veins = fractalNoise2D(19, 4);
  const img = hctx.createImageData(hw, hh);
  const data = img.data;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const n = shade(x / 110, y / 110);
      // Veins are stretched along a shallow diagonal so they read as quartz seams, not contour lines.
      const along = (x * 0.94 + y * 0.34) / 520;
      const across = (y * 0.94 - x * 0.34) / 70;
      const ridge = 1 - Math.abs(veins(along + 40, across) * 2 - 1);
      const vein = Math.pow(ridge, 40) * 7;
      const l = 11 + (n - 0.5) * 10 + vein;
      const i = (y * hw + x) * 4;
      data[i] = l;
      data[i + 1] = l;
      data[i + 2] = l + 1.5;
      data[i + 3] = 255;
    }
  }
  hctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(half, 0, 0, width, height);

  const rand = seededRandom(3);
  const specks = Math.round((width * height) / 240);
  for (let k = 0; k < specks; k++) {
    const light = rand() < 0.62;
    const a = Math.pow(rand(), 3) * (light ? 0.3 : 0.5);
    ctx.fillStyle = light ? `rgba(232,226,214,${a.toFixed(3)})` : `rgba(0,0,0,${a.toFixed(3)})`;
    ctx.fillRect(rand() * width, rand() * height, 1, 1);
  }
  // A few brighter glints, like mica catching light.
  const glints = Math.round((width * height) / 26000);
  for (let k = 0; k < glints; k++) {
    ctx.fillStyle = `rgba(255,246,228,${(0.25 + rand() * 0.4).toFixed(3)})`;
    const size = rand() < 0.8 ? 1 : 2;
    ctx.fillRect(rand() * width, rand() * height, size, size);
  }
}

export interface StoneProps {
  /*
   * A gold streak rubbed across the first screen. Pass false for the plain stone, or streak props
   * for a different path. A page that draws its own streak inside its hero passes false.
   */
  streak?: boolean | StreakProps;
}

/** The full-bleed black stone behind the whole page: canvas texture, grain and vignette. */
export function Stone({ streak = true }: StoneProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    let paintedWidth = 0;
    let timer = 0;

    const paint = (): void => {
      // Height uses the tallest of the viewport and the screen, so a phone's address bar sliding
      // away never uncovers an unpainted strip and never forces a repaint.
      const width = window.innerWidth;
      const height = Math.max(window.innerHeight, window.screen.height);
      if (width === paintedWidth) return;
      paintedWidth = width;
      paintStone(canvas, width, height);
      canvas.dataset.ready = "true";
    };

    // Deferred one tick so the headline paints first; the plain stone colour shows until then.
    timer = window.setTimeout(paint, 0);
    const onResize = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(paint, 180);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div aria-hidden="true">
      {/* SWAP: hero image. The painted stone stands in until a real touchstone photograph exists. */}
      <canvas ref={ref} className={b.stoneCanvas} />
      <div className={b.light} />
      <div className={b.vignette} />
      {streak !== false && (
        <div className={b.stoneStreak}>
          <Streak {...(streak === true ? {} : streak)} />
        </div>
      )}
      <div className={b.grain} style={{ backgroundImage: GRAIN_URL }} />
    </div>
  );
}
