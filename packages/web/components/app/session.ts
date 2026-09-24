"use client";

/*
 * Where the browser keeps what a team hands Urai (threat-model C22, amended at the gate review).
 * The SERV key lives only in this module's memory: it survives client-side navigation from /new to
 * /run/[id] but not a reload, and it never touches localStorage, sessionStorage or a cookie. The
 * run owner token is a spending and publishing capability, so it lives in sessionStorage at most
 * and dies with the tab, unless the owner copies it out as a private run link, which carries it after
 * a "#" so no request ever sends it and the page moves it back into sessionStorage on arrival.
 */

let teamKey: string | null = null;

export function setTeamKey(key: string | null): void {
  const k = key?.trim() ?? "";
  teamKey = k === "" ? null : k;
}

export function getTeamKey(): string | null {
  return teamKey;
}

export function clearTeamKey(): void {
  teamKey = null;
}

const OWNER_PREFIX = "urai.run.owner.";

// Storage can throw (private mode, blocked site data); the page then asks the owner to start again.
export function saveOwnerToken(runId: string, token: string): void {
  try {
    sessionStorage.setItem(OWNER_PREFIX + runId, token);
  } catch {
    // Nothing kept: this tab will not be able to reopen the run after a reload.
  }
}

export function readOwnerToken(runId: string): string | null {
  try {
    return sessionStorage.getItem(OWNER_PREFIX + runId);
  } catch {
    return null;
  }
}

export function forgetOwnerToken(runId: string): void {
  try {
    sessionStorage.removeItem(OWNER_PREFIX + runId);
  } catch {
    // Already unreachable.
  }
}

const HASH_PREFIX = "#owner=";
// 43 mirrors OWNER_TOKEN_CHARS in lib/ids.ts, which pulls in node:crypto and so cannot load in the browser.
const HASH_TOKEN = /^#owner=([A-Za-z0-9_-]{43})$/;

export function ownerTokenFromHash(hash: string): string | null {
  return HASH_TOKEN.exec(hash)?.[1] ?? null;
}

/*
 * Picks up a private run link. The fragment is cleared from the address bar whether or not the
 * token is valid, so it does not linger in history, a screenshot, or a link copied from the bar.
 */
export function takeOwnerTokenFromHash(runId: string): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  history.replaceState(history.state, "", location.pathname + location.search);
  const token = ownerTokenFromHash(hash);
  if (token === null) return null;
  saveOwnerToken(runId, token);
  return token;
}

export function privateRunLink(runId: string, token: string): string {
  return `${window.location.origin}/run/${encodeURIComponent(runId)}${HASH_PREFIX}${token}`;
}
