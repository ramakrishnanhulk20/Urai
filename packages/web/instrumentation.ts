/** Runs once when a server instance starts: a missing or invalid variable stops it loudly, by name. */
export async function register(): Promise<void> {
  // Every route runs on Node. The import stays inside the check so no Edge bundle pulls in node:crypto.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { serverEnv } = await import("./lib/env");
    serverEnv();
  }
}
