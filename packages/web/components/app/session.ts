"use client";

/*
 * Where the browser keeps what a team hands Urai (threat-model C22, amended at the gate review).
 * The SERV key lives only in this module's memory, held against the one run it was typed for: it
 * survives client-side navigation from /new to /run/[id] but not a reload, and it never touches
 * localStorage, sessionStorage or a cookie. The
 * run owner token is a spending and publishing capability, so it lives in sessionStorage at most
 * and dies with the tab, unless the owner copies it out as a private run link, which carries it after
 * a "#" so no request ever sends it and the page moves it back into sessionStorage on arrival.
 */

// Keyed by run id, so a key typed for one run can never pay for another run opened in the same tab.
const teamKeys = new Map<string, string>();

export function setTeamKey(runId: string, key: string | null): void {
  const k = key?.trim() ?? "";
  if (k === "") teamKeys.delete(runId);
  else teamKeys.set(runId, k);
}

export function getTeamKey(runId: string): string | null {
  return teamKeys.get(runId) ?? null;
}

export function clearTeamKey(runId: string): void {
  teamKeys.delete(runId);
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

/*
 * What /new does once a run exists: this tab keeps the run's owner token and the key goes to that
 * run id alone. Kept here so the hand-over is one tested step rather than two calls the builder
 * could get out of step.
 */
export function handOverRun(runId: string, ownerToken: string, key: string): void {
  saveOwnerToken(runId, ownerToken);
  setTeamKey(runId, key);
}

const LINKED_PREFIX = "urai.run.linked.";

/*
 * Set when this tab first opened the run from a private link. Anyone holding that link can open
 * the run, so such a run is shown for confirmation before a key is asked for and is never driven
 * without a press. The mark stays for the tab's life so a reload cannot skip the confirmation.
 */
export function openedFromLink(runId: string): boolean {
  try {
    return sessionStorage.getItem(LINKED_PREFIX + runId) === "1";
  } catch {
    // Unreadable storage means the token could not have been kept either, so fail towards asking.
    return true;
  }
}

function markLinked(runId: string): void {
  try {
    sessionStorage.setItem(LINKED_PREFIX + runId, "1");
  } catch {
    // The token itself was not kept either; the page asks again after a reload.
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
/*
 * Clears an owner fragment from the address bar without reading it. Next's router writes its own
 * idea of the URL into history while it settles after hydration, which can put the fragment back,
 * so the run page calls this again after that. history.state is kept because the router lives in it.
 */
export function stripOwnerHash(): void {
  if (!window.location.hash.startsWith(HASH_PREFIX)) return;
  history.replaceState(history.state, "", location.pathname + location.search);
}

export function takeOwnerTokenFromHash(runId: string): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  history.replaceState(history.state, "", location.pathname + location.search);
  const token = ownerTokenFromHash(hash);
  if (token === null) return null;
  saveOwnerToken(runId, token);
  markLinked(runId);
  return token;
}

export function privateRunLink(runId: string, token: string): string {
  return `${window.location.origin}/run/${encodeURIComponent(runId)}${HASH_PREFIX}${token}`;
}
