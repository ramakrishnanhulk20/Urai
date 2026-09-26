// Not covered here: pieces of the key shorter than 16 characters (they survive by design), a key
// echoed after some other encoding than JSON escaping (base64, URL encoding), and the callers
// (serv.test.ts drives scrubbing through runCase).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.js";
import { cutPairSafe, scrub, scrubDeep, shortMessage } from "../src/scrub.js";

const WINDOW = 16;

function windows(key: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + WINDOW <= key.length; i++) out.push(key.slice(i, i + WINDOW));
  return out;
}

function expectNoWindow(text: string, key: string): void {
  for (const piece of windows(key)) expect(text).not.toContain(piece);
  const escaped = JSON.stringify(key).slice(1, -1);
  for (const piece of windows(escaped)) expect(text).not.toContain(piece);
}

// A made-up key with a quote and a backslash in it, so its JSON-escaped form differs from the raw one.
const KEY = `sk-canary-${randomBytes(12).toString("hex")}"q\\${randomBytes(8).toString("hex")}`;

function forbidden(echo: string): string {
  return JSON.stringify({ error: { message: `Key ${echo} is not allowed to call this model`, type: "permission_error" } });
}

// A high surrogate with no low one after it, or a low one with no high one before it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("cutPairSafe never leaves half a character", () => {
  it("cuts a run of emoji at every offset around the error cap without a lone surrogate", () => {
    for (let pad = 0; pad < 4; pad++) {
      const text = `${"a".repeat(pad)}${"\u{1F600}".repeat(LIMITS.errorMaxChars)}`;
      for (let max = 0; max <= text.length; max++) {
        const out = cutPairSafe(text, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out.length).toBeGreaterThanOrEqual(max - 1);
        expect(text.startsWith(out)).toBe(true);
        expect(LONE_SURROGATE.test(out)).toBe(false);
      }
    }
  });

  it("keeps shortMessage well formed at the 200-character error cap for every alignment", () => {
    for (let pad = 0; pad < 2; pad++) {
      const msg = shortMessage(`${"x".repeat(pad)}${"\u{1F4B8}".repeat(LIMITS.errorMaxChars)}`, KEY);
      expect(msg.length).toBeLessThanOrEqual(LIMITS.errorMaxChars);
      expect(msg.length).toBeGreaterThanOrEqual(LIMITS.errorMaxChars - 1);
      expect(LONE_SURROGATE.test(msg)).toBe(false);
    }
  });

  it("returns text that already fits unchanged", () => {
    expect(cutPairSafe("ab\u{1F600}", 4)).toBe("ab\u{1F600}");
    expect(cutPairSafe("", 0)).toBe("");
  });
});

describe("scrub removes every 16-character piece of the key", () => {
  it("removes the first 24 characters of the key echoed in a 403-style message", () => {
    const out = scrub(forbidden(KEY.slice(0, 24)), KEY);
    expectNoWindow(out, KEY);
    expect(out).toContain("[key]");
    expect(out).toContain("is not allowed to call this model");
  });

  it("removes the last 20 characters of the key", () => {
    const out = scrub(`http_403: key ending ${KEY.slice(-20)} was refused`, KEY);
    expectNoWindow(out, KEY);
    expect(out).toBe("http_403: key ending [key] was refused");
  });

  it("removes a 16-character slice from the middle of the key", () => {
    const middle = KEY.slice(10, 26);
    const out = scrub(`forbidden for ...${middle}...`, KEY);
    expectNoWindow(out, KEY);
    expect(out).toBe("forbidden for ...[key]...");
  });

  it("removes the key in its JSON-escaped form, whole and in part", () => {
    const escaped = JSON.stringify(KEY).slice(1, -1);
    expect(escaped).not.toBe(KEY);
    const out = scrub(`{"echo":"${escaped}","tail":"${escaped.slice(-18)}"}`, KEY);
    expectNoWindow(out, KEY);
    expect(out).toBe('{"echo":"[key]","tail":"[key]"}');
  });

  it("replaces two pieces that overlap or touch with one [key], and keeps separate echoes separate", () => {
    expect(scrub(`a${KEY.slice(0, 20)}${KEY.slice(20, 40)}b`, KEY)).toBe("a[key]b");
    expect(scrub(`${KEY.slice(0, 16)} and ${KEY.slice(-16)}`, KEY)).toBe("[key] and [key]");
  });

  it("keeps a key shorter than 16 characters on the whole-key rule", () => {
    const short = "sk-short-a\"1";
    expect(short.length).toBeLessThan(WINDOW);
    const escaped = JSON.stringify(short).slice(1, -1);
    const out = scrub(`raw ${short} escaped ${escaped} part ${short.slice(0, 8)}`, short);
    expect(out).toBe(`raw [key] escaped [key] part ${short.slice(0, 8)}`);
    expectNoWindow(out, short);
  });

  it("leaves text with no piece of the key alone", () => {
    const text = "http_403: forbidden for this account";
    expect(scrub(text, KEY)).toBe(text);
    expect(scrub(text, "")).toBe(text);
  });

  it("carries through shortMessage and scrubDeep, object keys included", () => {
    const msg = shortMessage(`http_403: ${"x".repeat(150)} ${KEY.slice(3, 30)}`, KEY);
    expectNoWindow(msg, KEY);
    const deep = scrubDeep({ [KEY.slice(0, 17)]: [`tail ${KEY.slice(-17)}`] }, KEY);
    expectNoWindow(JSON.stringify(deep), KEY);
    expect(deep).toEqual({ "[key]": ["tail [key]"] });
  });
});
