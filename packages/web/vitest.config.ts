import { defineConfig } from "vitest/config";
import { loadRootEnv } from "./lib/root-env";

loadRootEnv();

export default defineConfig({
  test: {
    // .tsx picks up the report render test, which needs JSX. It renders to a string in Node, so no DOM environment.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      // Nothing in these tests spends demo money, but serverEnv() refuses to start without a budget.
      // The root .env value wins when it is set.
      DEMO_DAILY_BUDGET_USD: process.env.DEMO_DAILY_BUDGET_USD ?? "1.00",
    },
  },
});
