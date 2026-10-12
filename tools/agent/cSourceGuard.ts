/** CLI boundary for the side-effect-free C source analysis API. Keeping the
 * entrypoint out of library imports lets scriptHost install argv/context BEFORE
 * importing it; importing analysis must never consume a CLI invocation. */
export * from "./cSourceAnalysis.js";
import { analyzeCFile } from "./cSourceAnalysis.js";

function main(argv: string[]): void {
  const paths = argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: npx tsx tools/agent/cSourceGuard.ts <file.c> [more.c ...]");
    process.exit(2);
  }
  const reports = paths.map(path => ({ path, ...analyzeCFile(path) }));
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  process.exit(reports.every(report => report.parses) ? 0 : 1);
}
if (process.argv[1]?.endsWith("cSourceGuard.ts")) main(process.argv);
