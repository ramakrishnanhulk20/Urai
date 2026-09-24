/** A small seeded random source, so the stone and the streak look the same on every redraw. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value noise in 0..1 on a 256 cell lattice that wraps. */
export function valueNoise2D(seed: number): (x: number, y: number) => number {
  const rand = seededRandom(seed);
  const size = 256;
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (x: number, y: number): number => grid[(y & (size - 1)) * size + (x & (size - 1))]!;
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * u;
    const bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * u;
    return top + (bottom - top) * v;
  };
}

/** Layered value noise: big soft shapes with finer detail on top, still in 0..1. */
export function fractalNoise2D(seed: number, octaves: number): (x: number, y: number) => number {
  const base = valueNoise2D(seed);
  return (x, y) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let o = 0; o < octaves; o++) {
      sum += base(fx + o * 31.7, fy - o * 17.3) * amp;
      norm += amp;
      amp *= 0.5;
      fx *= 2.03;
      fy *= 2.03;
    }
    return sum / norm;
  };
}
