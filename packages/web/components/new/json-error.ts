/*
 * Browsers word JSON.parse errors differently, and older ones give only a character position.
 * This turns whatever they say into a line and column the reader can find in the textarea.
 */
export function jsonErrorAt(text: string, err: unknown): string {
  const message = err instanceof Error ? err.message : "could not be read";
  if (/line \d+ column \d+/i.test(message)) return message;
  const pos = /position (\d+)/i.exec(message);
  if (pos === null) return message;
  const at = Math.min(Number(pos[1]), text.length);
  const before = text.slice(0, at);
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  return `${message.replace(/\s*at position \d+.*$/i, "")} at line ${line}, column ${column}`;
}
