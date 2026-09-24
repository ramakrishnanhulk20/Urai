import type { CSSProperties } from "react";
import b from "./brand.module.css";

export interface SlashProps {
  /** Height of the mark. A number is pixels; a string is any CSS length. The width follows at 0.6. */
  size?: number | string;
  /** Sets the mark beside the URAI wordmark, as in the header and footer. */
  wordmark?: boolean;
  className?: string;
}

/*
 * The motif: one short diagonal gold slash, the shape a single rub leaves on a touchstone.
 * The same mark is the logo, the list bullet, the section marker, the favicon and the share card.
 * Flat fills rather than a gradient, because a gradient needs an id and this mark repeats on a page.
 */
export function Slash({ size, wordmark = false, className }: SlashProps) {
  const style =
    size === undefined ? undefined : ({ "--slash-size": typeof size === "number" ? `${size}px` : size } as CSSProperties);

  const mark = (
    <svg
      className={!wordmark && className ? `${b.slash} ${className}` : b.slash}
      style={wordmark ? undefined : style}
      viewBox="0 0 12 20"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="8,0 12,0 4,20 0,20" fill="#e2b04a" />
      <polygon points="8,0 12,0 10.4,4 6.4,4" fill="#f4d58c" />
    </svg>
  );

  if (!wordmark) return mark;

  const lockup = [b.lockup, size === undefined ? "" : b.lockupSized, className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={lockup} style={style}>
      {mark}
      <span>Urai</span>
    </span>
  );
}
