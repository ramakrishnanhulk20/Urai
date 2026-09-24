import summary from "../../lib/security-summary.json";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Built by hand because Intl's en-GB short month is "Sept" on some runtimes and "Sep" on others.
function utcDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Must match how scripts/verify-security.ts names the record it writes for a run.
const recordFile = `run-${summary.runAt.replaceAll(":", "-")}.md`;

export function SecurityRecord() {
  return (
    <>
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
      <p>
        Latest run: {utcDay(summary.runAt)}, UTC, budget checks {summary.budgetChecks ? "included" : "skipped"}.
        Record: <code>{recordFile}</code>
      </p>
    </>
  );
}
