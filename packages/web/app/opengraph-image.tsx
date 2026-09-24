import { ImageResponse } from "next/og";

export const alt = "Urai: is SERV gold for your agent?";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const STONE = "#0b0b0c";
const TEXT = "#efe9df";
const GOLD = "#e2b04a";
const GOLD_HI = "#f4d58c";

const HEADLINE_TEXT = "IS SERV GOLD FOR YOUR AGENT?";
const WORDMARK_TEXT = "URAI";

/*
 * The card renderer only reads static TTF or OTF files, and next/font keeps Archivo as a variable
 * woff2, so each width is asked of Google Fonts as a static cut, trimmed to the letters used.
 * Returns null when the network is unavailable; the card then falls back to the renderer's own
 * sans, still bold, rather than failing the route.
 */
async function archivoCut(width: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const query = `family=Archivo:wdth,wght@${width},900&text=${encodeURIComponent(text)}`;
    const css = await (await fetch(`https://fonts.googleapis.com/css2?${query}`)).text();
    const url = /src: url\(([^)]+)\) format\('(?:truetype|opentype)'\)/.exec(css)?.[1];
    if (url === undefined) return null;
    const file = await fetch(url);
    return file.ok ? await file.arrayBuffer() : null;
  } catch {
    return null;
  }
}

const [condensed, wide] = await Promise.all([archivoCut(70, HEADLINE_TEXT), archivoCut(125, WORDMARK_TEXT)]);

const fonts = [
  ...(condensed ? [{ name: "Archivo Condensed", data: condensed, weight: 900 as const, style: "normal" as const }] : []),
  ...(wide ? [{ name: "Archivo Wide", data: wide, weight: 900 as const, style: "normal" as const }] : []),
];

// The same film grain the site lays over the stone, as a tile the renderer can paint.
const GRAIN = `data:image/svg+xml;base64,${Buffer.from(
  "<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='630'>" +
    "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/>" +
    "<feColorMatrix type='saturate' values='0'/></filter>" +
    "<rect width='100%' height='100%' filter='url(#g)'/></svg>",
).toString("base64")}`;

const SLASH_H = 380;
const SLASH_W = SLASH_H * 0.6;

/*
 * The big slash, rubbed rather than flat. The gold is laid on a layer turned to the slash's own
 * angle, so the striations and the light-to-dark falloff run along the mark and across it, then
 * clipped to the slash shape so the logo's outline stays crisp.
 */
const RUBBED_SLASH = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${SLASH_W}' height='${SLASH_H}'>` +
    "<defs>" +
    `<clipPath id='c'><polygon points='${SLASH_W * (2 / 3)},0 ${SLASH_W},0 ${SLASH_W / 3},${SLASH_H} 0,${SLASH_H}'/></clipPath>` +
    "<linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>" +
    "<stop offset='0' stop-color='#fbe8b6'/><stop offset='0.35' stop-color='#e2b04a'/>" +
    "<stop offset='0.7' stop-color='#c8952f'/><stop offset='1' stop-color='#8f6620'/></linearGradient>" +
    "<filter id='r' x='0' y='0' width='100%' height='100%'>" +
    "<feTurbulence type='fractalNoise' baseFrequency='0.006 0.3' numOctaves='3' seed='5' stitchTiles='stitch'/>" +
    "<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3.2 0 0 0 -0.8'/>" +
    "<feComposite in='SourceGraphic' operator='in'/></filter>" +
    "</defs>" +
    "<g clip-path='url(#c)'>" +
    `<g transform='rotate(-68.2 ${SLASH_W / 2} ${SLASH_H / 2})'>` +
    `<rect x='${SLASH_W / 2 - SLASH_H}' y='${SLASH_H / 2 - SLASH_W * 0.2}' width='${SLASH_H * 2}' height='${SLASH_W * 0.4}' fill='url(#g)' opacity='0.22'/>` +
    `<rect x='${SLASH_W / 2 - SLASH_H}' y='${SLASH_H / 2 - SLASH_W * 0.2}' width='${SLASH_H * 2}' height='${SLASH_W * 0.4}' fill='url(#g)' filter='url(#r)'/>` +
    "</g></g></svg>",
).toString("base64")}`;

function SlashMark({ height }: { height: number }) {
  return (
    <svg width={height * 0.6} height={height} viewBox="0 0 12 20">
      <polygon points="8,0 12,0 4,20 0,20" fill={GOLD} />
      <polygon points="8,0 12,0 10.4,4 6.4,4" fill={GOLD_HI} />
    </svg>
  );
}

export default function OpenGraphImage() {
  const display = condensed ? "Archivo Condensed" : "sans-serif";
  const mark = wide ? "Archivo Wide" : "sans-serif";

  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          display: "flex",
          width: "100%",
          height: "100%",
          background: STONE,
          color: TEXT,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            background:
              "radial-gradient(60% 70% at 82% 8%, rgba(255, 236, 200, 0.10), rgba(255, 236, 200, 0) 70%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: -60,
            top: -40,
            width: 560,
            height: 520,
            display: "flex",
            background: "radial-gradient(50% 50% at 50% 50%, rgba(226, 176, 74, 0.16), rgba(226, 176, 74, 0) 70%)",
          }}
        />
        <img
          src={RUBBED_SLASH}
          width={SLASH_W}
          height={SLASH_H}
          style={{ position: "absolute", right: 104, top: 30 }}
          alt=""
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            background:
              "radial-gradient(120% 110% at 40% 45%, rgba(0, 0, 0, 0) 45%, rgba(0, 0, 0, 0.55) 85%, rgba(0, 0, 0, 0.8) 100%)",
          }}
        />
        <img src={GRAIN} width={1200} height={630} style={{ position: "absolute", inset: 0, opacity: 0.07 }} alt="" />

        <div
          style={{
            position: "absolute",
            left: 72,
            top: 60,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontFamily: mark,
            fontSize: 30,
            fontWeight: 900,
            letterSpacing: "0.04em",
          }}
        >
          <SlashMark height={38} />
          <span>{WORDMARK_TEXT}</span>
        </div>

        <div
          style={{
            position: "absolute",
            left: 68,
            bottom: 58,
            display: "flex",
            flexDirection: "column",
            fontFamily: display,
            fontSize: condensed ? 150 : 96,
            fontWeight: 900,
            lineHeight: 0.9,
            letterSpacing: "-0.02em",
          }}
        >
          <div style={{ display: "flex" }}>
            <span>IS SERV</span>
            <span
              style={{
                marginLeft: "0.11em",
                backgroundImage: "linear-gradient(180deg, #f6dc98 0%, #e2b04a 40%, #c8952f 75%, #8f6620 100%)",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              GOLD
            </span>
          </div>
          <div style={{ display: "flex" }}>FOR YOUR AGENT?</div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
