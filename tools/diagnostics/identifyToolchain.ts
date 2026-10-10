/** Identification observations and configured tools are intentionally separate.
 * This command never edits toolchain.json or invents compiler/ABI flags. */
import { execFileSync } from "node:child_process";
import { configuredSdk, HARNESS_ROOT, loadToolchain } from "../lib/toolchain.js";
import { detectToolchain } from "../lib/toolchainProfile.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("npm run identify -- [--deep] [--json]\n--deep runs the PSY-Q signature comparison (requires a target and measured section layout).\nReports evidence separately from configured choices; never writes configuration.");
} else {
  try {
    for (const arg of args) if (!["--deep", "--json"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    if (args.includes("--deep")) execFileSync(process.execPath, ["--import", "tsx", "tools/diagnostics/matchSignatures.ts"], { cwd: HARNESS_ROOT, stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 });
    const config = loadToolchain();
    const report = {
      detected: detectToolchain({ deep: args.includes("--deep"), refresh: true }),
      configured: { compiler: config.compiler, sdk: configuredSdk(), profiles: config.containerProfiles },
      limitations: ["SDK signatures do not identify the original compiler version, optimization flags or assembler version.",
        "A configured compiler/profile is a candidate, not evidence. Mixed SDKs or tied signature counts require review.",
        "Container layout/archive adapters still have supported-format assumptions; see docs/game-agnosticity.md."],
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
