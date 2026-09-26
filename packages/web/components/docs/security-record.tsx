import summary from "../../lib/security-summary.json";
import { ScrollRegion } from "./scroll-region";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Built by hand because Intl's en-GB short month is "Sept" on some runtimes and "Sep" on others.
function utcDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Must match how scripts/verify-security.ts names the record it writes for a run.
const recordFile = `run-${summary.runAt.replaceAll(":", "-")}.md`;
const recordUrl = `https://github.com/ramakrishnanhulk20/Urai/blob/main/docs/security/checks/${recordFile}`;

export function SecurityRecord() {
  return (
    <>
      <ScrollRegion label="Table: latest security check result, OK, Broken, Pending">
        <table>
          <thead>
            <tr>
              <th>OK</th>
              <th>Broken</th>
              <th>Pending</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{summary.ok}</td>
              <td>{summary.broken}</td>
              <td>{summary.pending}</td>
            </tr>
          </tbody>
        </table>
      </ScrollRegion>
      <p>
        Latest run: {utcDay(summary.runAt)}, UTC, budget checks {summary.budgetChecks ? "included" : "skipped"}.
        Record:{" "}
        <a href={recordUrl}>
          <code>{recordFile}</code>
        </a>
      </p>
    </>
  );
}
