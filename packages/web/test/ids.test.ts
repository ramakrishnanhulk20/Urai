// Not covered here: how ids are used by the routes (routes.test.ts) or any database behaviour.
import { describe, expect, it } from "vitest";
import { hashToken, isGeneratedId, newId, newOwnerToken, tokenMatches } from "../lib/ids";

describe("ids and owner tokens", () => {
  it("draws 22-character base64url ids with no repeat over 1,000 draws", () => {
    const ids = Array.from({ length: 1000 }, newId);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isGeneratedId(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(1000);
  });

  it("draws 43-character owner tokens that can never pass as an id", () => {
    const t = newOwnerToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isGeneratedId(t)).toBe(false);
    expect(newOwnerToken()).not.toBe(t);
  });

  it("matches a token only against its own hash", () => {
    const t = newOwnerToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenMatches(t, h)).toBe(true);
    expect(tokenMatches(newOwnerToken(), h)).toBe(false);
    expect(tokenMatches(null, h)).toBe(false);
    expect(tokenMatches("", h)).toBe(false);
    expect(tokenMatches(` ${t.slice(1)}`, h)).toBe(false);
    expect(tokenMatches(t, "not-a-hash")).toBe(false);
  });
});
