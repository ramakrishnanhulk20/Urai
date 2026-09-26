// Not covered here: how the confirm and share screens look and behave in a real browser, which the Playwright check proves.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTeamKey,
  getTeamKey,
  handOverRun,
  openedFromLink,
  ownerTokenFromHash,
  privateRunLink,
  readOwnerToken,
  setTeamKey,
  takeOwnerTokenFromHash,
} from "../components/app/session";
import { getStatus } from "../components/run/api";
import { publicItems, ShareConfirm, SharePanel, type ShareState } from "../components/run/finished";

// react-dom ships no type declarations here, so the one function used is loaded with its signature written out.
const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (node: ReactNode) => string;
};

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

function fakeSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

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

describe("team key per run", () => {
  afterEach(() => {
    for (const id of ["runA", "runB", "created", "other", "linked"]) clearTeamKey(id);
    vi.unstubAllGlobals();
  });

  it("returns a key only for the run it was set for", () => {
    setTeamKey("runA", "key-for-a");
    expect(getTeamKey("runA")).toBe("key-for-a");
    expect(getTeamKey("runB")).toBeNull();
  });

  it("keeps two runs' keys apart", () => {
    setTeamKey("runA", "key-for-a");
    setTeamKey("runB", "key-for-b");
    expect(getTeamKey("runA")).toBe("key-for-a");
    expect(getTeamKey("runB")).toBe("key-for-b");
  });

  it("clears one run's key without touching another's", () => {
    setTeamKey("runA", "key-for-a");
    setTeamKey("runB", "key-for-b");
    clearTeamKey("runA");
    expect(getTeamKey("runA")).toBeNull();
    expect(getTeamKey("runB")).toBe("key-for-b");
  });

  it("trims the key and treats a blank one as no key", () => {
    setTeamKey("runA", "  key-for-a \n");
    expect(getTeamKey("runA")).toBe("key-for-a");
    setTeamKey("runA", "   ");
    expect(getTeamKey("runA")).toBeNull();
  });

  it("hands the key from /new to exactly the run it created", () => {
    fakeSessionStorage();
    handOverRun("created", TOKEN, "the-builder-key");
    expect(getTeamKey("created")).toBe("the-builder-key");
    expect(getTeamKey("other")).toBeNull();
    expect(readOwnerToken("created")).toBe(TOKEN);
    expect(readOwnerToken("other")).toBeNull();
  });

  it("does not mark a run created in this tab as opened from a link", () => {
    fakeSessionStorage();
    handOverRun("created", TOKEN, "the-builder-key");
    expect(openedFromLink("created")).toBe(false);
  });

  it("marks a run opened from a private link, carries no key, and strips the fragment", () => {
    fakeSessionStorage();
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { hash: `#owner=${TOKEN}` } });
    vi.stubGlobal("location", { pathname: "/run/linked", search: "" });
    vi.stubGlobal("history", { state: null, replaceState });
    setTeamKey("runA", "key-for-a");

    expect(takeOwnerTokenFromHash("linked")).toBe(TOKEN);
    expect(openedFromLink("linked")).toBe(true);
    expect(readOwnerToken("linked")).toBe(TOKEN);
    expect(getTeamKey("linked")).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/run/linked");
  });
});

describe("share disclosure", () => {
  it("lists everything the public page shows", () => {
    const items = publicItems(true).join("\n");
    for (const part of [
      "system prompt",
      "shared data",
      "answer schema",
      "input, up to its first 2,000 characters",
      "expected answers",
      "answers and the scores",
    ]) {
      expect(items).toContain(part);
    }
  });

  it("leaves out shared data when the run has none", () => {
    expect(publicItems(false).join("\n")).not.toContain("shared data");
  });

  it("renders the list with an explicit confirm and a way to keep it private", () => {
    const html = renderToString(createElement(ShareConfirm, { hasContext: true, onConfirm: () => {}, onCancel: () => {} }));
    for (const item of publicItems(true)) expect(html).toContain(item.replaceAll("'", "&#x27;"));
    expect(html).toContain("Yes, make it public");
    expect(html).toContain("Keep it private");
  });
});

describe("share state on load", () => {
  afterEach(() => vi.unstubAllGlobals());

  function statusBody(extra: Record<string, unknown>): void {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ payer: "team", totalCalls: 80, ...extra }), { status: 200 }));
  }

  it("reads the real sharing state from the run status", async () => {
    statusBody({ shared: true });
    expect(await getStatus("run", TOKEN)).toEqual({ ok: true, value: { payer: "team", totalCalls: 80, shared: true } });
    statusBody({ shared: false });
    expect(await getStatus("run", TOKEN)).toEqual({ ok: true, value: { payer: "team", totalCalls: 80, shared: false } });
  });

  it("reads a status without the field as unknown, never as private", async () => {
    statusBody({});
    const out = await getStatus("run", TOKEN);
    expect(out.ok && out.value.shared).toBe(null);
  });

  function panel(state: ShareState): string {
    return renderToString(createElement(SharePanel, { state, hasContext: false, onShare: () => {}, onUnshare: () => {} }));
  }

  it("says a public report is public and offers Unshare", () => {
    const html = panel({ kind: "public" });
    expect(html).toContain("This report is public");
    expect(html).toContain("Unshare");
    expect(html).toContain("Show the public link");
    expect(html).not.toContain("private until you share it");
  });

  it("offers no Unshare on a report that was never shared", () => {
    const html = panel({ kind: "private", again: false });
    expect(html).toContain("private until you share it");
    expect(html).not.toContain("Unshare");
  });

  it("uses the button label the share guide names", () => {
    const guide = readFileSync(join(__dirname, "..", "content", "docs", "guides", "share-a-report.mdx"), "utf8");
    expect(guide).toContain('"Unshare"');
    expect(guide).not.toContain("Make sure it is private");
    expect(panel({ kind: "shared", reportId: "abc" })).toContain("Unshare");
  });
});
