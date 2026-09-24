import { Archivo, Geist_Mono } from "next/font/google";

/*
 * One variable family carries both the display and the body. Its width axis runs from 62 to 125,
 * so the headline can be set tall and condensed like poster billing while the big percentages are
 * set wide and black like a hallmark stamped into metal. Body copy sits at the normal width.
 */
export const displayFont = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-display",
  display: "swap",
});

// Labels only: metadata rows, captions and section markers.
export const monoFont = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});
