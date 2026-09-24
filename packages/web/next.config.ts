import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";
import { loadRootEnv } from "./lib/root-env";

loadRootEnv();

const nextConfig: NextConfig = {
  // The engine ships TypeScript source, not a build.
  transpilePackages: ["@urai/engine"],
  experimental: {
    // The engine is written for Node's own resolver and imports "./x.js" for "./x.ts". Turbopack
    // has no equivalent of this option, which is why the scripts build with --webpack.
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  // A verification build sets NEXT_DIST_DIR so it never overwrites the .next a dev server is using.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // next dev otherwise writes AGENTS.md and CLAUDE.md into this package on every start.
  agentRules: false,
  headers() {
    // Covers the replies Next writes itself (automatic OPTIONS, 405), which never pass through lib/http.ts.
    const api = { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] };
    // Dev tooling needs eval and a websocket, so the policy is production only.
    if (process.env.NODE_ENV !== "production") return [api];
    // connect-src 'self' is the line that keeps the team key home (C34): a script that got into the page cannot post it to another host.
    // Scripts need 'unsafe-inline' because Next's bootstrap scripts are inline, and a nonce would make every page dynamic.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
    return [
      api,
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

// Only lib/source.ts declares a collection, so the macro loader has no reason to read every other module.
const withMDX = createMDX({ macro: { include: ["lib/source.ts"] } });

export default withMDX(nextConfig);
