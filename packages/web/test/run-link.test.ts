// Not covered here: takeOwnerTokenFromHash's address-bar and sessionStorage side effects, which the browser check proves.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerTokenFromHash, privateRunLink } from "../components/app/session";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

describe("private run link", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a 43-character base64url token in the fixture", () => {
    expect(TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("reads a valid token from #owner=", () => {
    expect(ownerTokenFromHash(`#owner=${TOKEN}`)).toBe(TOKEN);
  });

  it("refuses 42 and 44 characters", () => {
    expect(ownerTokenFromHash(`#owner=${TOKEN.slice(0, 42)}`)).toBeNull();
    expect(ownerTokenFromHash(`#owner=${TOKEN}a`)).toBeNull();
  });

  it("refuses a character outside base64url", () => {
    expect(ownerTokenFromHash(`#owner=${TOKEN.slice(0, 42)}+`)).toBeNull();
    expect(ownerTokenFromHash(`#owner=${TOKEN.slice(0, 42)}=`)).toBeNull();
  });

  it("refuses a hash without the leading #", () => {
    expect(ownerTokenFromHash(`owner=${TOKEN}`)).toBeNull();
  });

  it("refuses a different key name", () => {
    expect(ownerTokenFromHash(`#token=${TOKEN}`)).toBeNull();
    expect(ownerTokenFromHash(`#Owner=${TOKEN}`)).toBeNull();
  });

  it("refuses extra text after the token", () => {
    expect(ownerTokenFromHash(`#owner=${TOKEN}&x=1`)).toBeNull();
    expect(ownerTokenFromHash(`#owner=${TOKEN}\n`)).toBeNull();
  });

  it("refuses an empty string", () => {
    expect(ownerTokenFromHash("")).toBeNull();
  });

  it("builds the link on this origin with the token after #", () => {
    vi.stubGlobal("window", { location: { origin: "https://example.test" } });
    expect(privateRunLink("run123", TOKEN)).toBe(`https://example.test/run/run123#owner=${TOKEN}`);
  });

  it("encodes a run id with a slash", () => {
    vi.stubGlobal("window", { location: { origin: "https://example.test" } });
    expect(privateRunLink("a/b", TOKEN)).toBe(`https://example.test/run/a%2Fb#owner=${TOKEN}`);
  });
});
