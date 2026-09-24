import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Slash } from "../components/brand/slash";

// Our site header already carries the wordmark and the main links, so the sidebar title stays small.
// The theme switch is off because the site has no light mode.
export function docsLayoutOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5em" }}>
          <Slash size={16} />
          Urai docs
        </span>
      ),
      url: "/docs",
    },
    themeSwitch: { enabled: false },
  };
}
