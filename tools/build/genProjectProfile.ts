import { execFileSync as installedExec } from "node:child_process";
import { currentScriptArgs } from "../lib/installedScripts.js";
import { projectRoot } from "../lib/runtimeContext.js";
/**
 * genProjectProfile.ts — Generate configs/project-profile.md from machine-readable sources
 *
 * The agent prompts in prompts/ are toolchain-agnostic; the profile supplies
 * the concrete toolchain facts. Nearly all of them are already canonical
 * elsewhere, so this tool DERIVES the profile instead of trusting prose:
 *
 *   - Load address, entry point, $gp   → PS-X EXE header + splat.yaml (via psxExeInfo)
 *   - Compiler version, cc1 flags      → Makefile (GCC_VERSION, CC1FLAGS)
 *   - Small-data (-G) threshold        → parsed from CC1FLAGS
 *   - ASPSX version                    → Makefile (--aspsx-version)
 *   - Game serial (e.g. SLUS-01115)    → EXE filename pattern
 *   - SDK version                      → auto-detected via matchSignatures.ts (~6s)
 *   - Byte-identity claim              → VERIFIED at generation time by hashing
 *                                        build/<basename>.bin against the payload
 *                                        (same slice the Makefile check target uses)
 *
 * The only fact that cannot be derived lives in configs/project-info.json:
 *   { "game": "Harvest Moon: Back to Nature",
 *     "evidence": "notes/toolchain-version-detection.md" }
 *
 * Usage:
 *   npx tsx tools/build/genProjectProfile.ts           # dry run: print to stdout
 *   npx tsx tools/build/genProjectProfile.ts --write   # write configs/project-profile.md
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { loadPsxExeInfo, exeBasename } from "../lib/psxExeInfo.ts";
import { digest, snapshot, readCache, writeCache, writeIfChanged } from "../lib/contentCache.js";

const INFO_PATH = () => (join(projectRoot(), "configs/project-info.json"));
const OUT_PATH = () => (join(projectRoot(), "configs/project-profile.md"));
import { configuredFlags, configuredSdk, loadToolchain, type FlagContext } from "../lib/toolchain.js";
import { libraryContext, loadLibraryProject } from "../lib/project.js";

/* --- helpers --- */

function hex32(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** slus_011.15 → SLUS-01115 (also handles sles/sces/slps etc.) */
function serialFromPath(binaryPath: string): string | null {
  const m = basename(binaryPath).match(/^([a-z]{4})_(\d{3})\.(\d{2})$/i);
  if (!m) return null;
  return `${m[1].toUpperCase()}-${m[2]}${m[3]}`;
}

interface HeaderRole {
  role: string;
  path: string;
  readonly?: boolean;
  generated?: boolean;
}

interface ProjectInfo {
  game?: string;
  evidence?: string;
  headers?: HeaderRole[];
}

function loadProjectInfo(): ProjectInfo {
  if (!existsSync(INFO_PATH())) return {};
  return JSON.parse(readFileSync(INFO_PATH(), "utf-8"));
}

interface ToolchainFacts {
  family: string;
  gccVersion: string;
  cc1Flags: string;
  gThreshold: number | null;
  aspsxVersion: string | null;
  builtBin: string | null;
}

function parseToolchain(context: FlagContext): ToolchainFacts {
  const config = loadToolchain();
  const flags = configuredFlags("cc1", context);
  const shim = configuredFlags("maspsx", context);
  const threshold = flags.find(flag => /^-G\d+$/.test(flag));
  const aspsx = shim.indexOf("--aspsx-version");
  return { family: config.compiler.family, gccVersion: config.compiler.version, cc1Flags: flags.join(" "),
    gThreshold: threshold ? Number(threshold.slice(2)) : null,
    aspsxVersion: aspsx >= 0 ? shim[aspsx + 1] ?? null : null,
    builtBin: context.kind === "library" ? null : join(projectRoot(), "build", `${exeBasename()}.bin`) };
}

/** Hash the built binary against the original payload — the byte-identity
 *  claim is only emitted when it is actually true at generation time.
 *  Mirrors the Makefile check target: both sides skip the EXE header. */
function verifyByteIdentity(
  binaryPath: string,
  payloadOffset: number,
  payloadSize: number,
  builtBin: string | null
): { verified: boolean; detail: string } {
  if (!builtBin || !existsSync(builtBin)) {
    return { verified: false, detail: "built binary not found — run `npm run build` first" };
  }
  const originalBytes = readFileSync(binaryPath), builtBytes = readFileSync(builtBin);
  if (originalBytes.length < payloadOffset + payloadSize || builtBytes.length < payloadOffset + payloadSize) return { verified: false, detail: "original or built payload is truncated" };
  const orig = originalBytes.subarray(payloadOffset, payloadOffset + payloadSize);
  const built = builtBytes.subarray(payloadOffset, payloadOffset + payloadSize);
  if (sha256(orig) === sha256(built)) {
    return { verified: true, detail: "SHA-256 match confirmed at generation time" };
  }
  return { verified: false, detail: "built binary DOES NOT match the original payload" };
}

/** Auto-detect the PSY-Q SDK version via signature matching.
 *  Formats raw dir names: 470 → "4.7", 3610 → "3.6.10". */
function detectSdkVersion(): { version: string; detail: string } | null {
  try {
    const key = digest(JSON.stringify(snapshot(projectRoot(), [loadPsxExeInfo().binaryPath, "build/sectionLayout.json", "configs/splat/exe.yaml",
      dirname(configuredSdk().signatures), "toolchain.json", "tools/diagnostics/matchSignatures.ts", "tools/lib/psxExeInfo.ts",
      "tools/lib/container.ts", "tools/lib/overlayManifest.ts", "tools/lib/contentCache.ts", "tools/build/genProjectProfile.ts", "package-lock.json"],
      (p) => !p.includes("/.git/") && (p.endsWith(".json") || p.endsWith(".ts") || p.endsWith(".yaml")))));
    const cache = join(projectRoot(), "build/cache/sdk-detection.json");
    const hit = readCache<{ version: string; detail: string }>(cache, key);
    if (hit) { console.error("SDK detection: cache hit (inputs unchanged)"); return hit; }
    console.error("SDK detection: cache miss (absent, corrupt or changed inputs)");
    const out = installedExec(process.execPath, currentScriptArgs("tools/diagnostics/matchSignatures.ts", []), {
      cwd: projectRoot(),
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/Best match: PSY-Q (\S+) \((\d+) signatures\)/);
    if (!m) return null;
    const digits = m[1];
    let version = `${digits[0]}.${digits[1]}`;
    if (digits.length > 2 && digits.slice(2) !== "0") version += `.${digits.slice(2)}`;
    const result = { version, detail: `${m[2]} signatures matched` };
    writeCache(cache, key, result);
    return result;
  } catch {
    return null;
  }
}

/** Whether a header is generated is a property of the file, not of prose:
 *  every generator in this project stamps a do-not-edit banner at the top.
 *  Derive the column rather than letting configs/project-info.json assert it,
 *  so a header that stops being generated cannot keep a stale label. */
function headerEditability(path: string): string {
  const full = join(projectRoot(), path);
  if (!existsSync(full)) return "**MISSING** — configured but not present";
  if (statSync(full).isDirectory()) return "hand-edited directory (inspect file banners)";
  const banner = readFileSync(full, "utf-8").split("\n").slice(0, 6).join("\n");
  const generator = banner.match(/(?:Generated|Auto-generated) by ([^\s—-]+)/i)?.[1];
  if (/do not edit/i.test(banner)) {
    return generator
      ? `generated by \`${generator}\` — **never hand-edit**`
      : "generated — **never hand-edit**";
  }
  return "hand-edited";
}

function headersSection(headers: HeaderRole[] | undefined): string {
  if (!headers || headers.length === 0) return "";
  const rows = headers
    .map((entry) => `| ${entry.role} | \`${entry.path}\` | ${entry.readonly ? "reference — **never edit**" : entry.generated ? "generated — **never hand-edit**" : headerEditability(entry.path)} |`)
    .join("\n");
  return `
## Headers — where a declaration or type belongs

| Role | File | Status |
|---|---|---|
${rows}

A generated header is an output. To change what it says, change its generator's
input or put the fact in the override header it defers to — editing it directly
is lost on the next regeneration. Give a data symbol its struct or aggregate
type in the override header, never in a \`.c\` file and never in the generated
one. Restating a generated declaration in a source file is a redeclaration;
*defining* a symbol the translation unit owns is a different thing and is
required — see the small-data threshold above.
`;
}

/* --- main --- */

export function generateProjectProfile(args: string[] = []) {
  const write = args.includes("--write");

  const project = loadLibraryProject();
  const exe = project ? null : loadPsxExeInfo();
  const info = loadProjectInfo();
  const context: FlagContext = project ? libraryContext("default") : { id: "exe", kind: "exe" };
  const mk = parseToolchain(context);

  const serial = exe ? serialFromPath(exe.binaryPath) : null;
  const gameLine = info.game
    ? `${info.game}${serial ? ` (${serial})` : ""}`
    : serial ?? (project ? "relocatable target" : "(unknown — set \"game\" in configs/project-info.json)");

  const check = exe ? verifyByteIdentity(exe.binaryPath, exe.payloadOffset, exe.payloadSize, mk.builtBin)
    : { verified: false, detail: "generate a fresh owning-TU verdict with the normal diff/finalization tools" };
  const sdk = exe ? detectSdkVersion() : null;

  const sdkLine = sdk
    ? `PSY-Q ${sdk.version} (signature candidate, not proof of original compiler/SDK homogeneity — ${sdk.detail}, \`tools/diagnostics/matchSignatures.ts\`)`
    : project ? `configured SDK ${loadToolchain().sdk.version}; reference headers are evidence, not compiler identity`
      : "(detection failed — run tools/diagnostics/matchSignatures.ts manually)";

  const evidenceRef = info.evidence ? ` (evidence: \`${info.evidence}\`)` : "";

  const verifiedSentence = check.verified
    ? `- **Configured compiler:** ${mk.family} ${mk.gccVersion} (\`cc1\`) — output matches the original payload${evidenceRef}; ${check.detail}. This validates output, not original compiler identity.`
    : `- **Configured compiler:** ${mk.family} ${mk.gccVersion} (\`cc1\`) — byte-identity NOT confirmed at generation time (${check.detail})`;

  /* Size is a necessary condition for GP-relative addressing, not the
   * decision: the assembler only uses `$gp` for symbols the translation unit
   * declares itself. Stating the threshold without that qualifier is what
   * produced a round of array over-declarations. */
  const gSentence = mk.gThreshold !== null
    ? `\`-G${mk.gThreshold}\` — a global can be reached GP-relatively (single \`lw/sw %gp_rel(sym)($gp)\`) only if it is declared **${mk.gThreshold} bytes or smaller**, *and* the file **defines** it (a tentative definition, so cc1 emits \`.comm\`). A file that only declares it \`extern\` gets absolute addressing (\`lui\` + \`lw/sw %lo(sym)\`) whatever the size. Never enlarge a declaration to force absolute addressing; derive ownership from the target's sections and symbols`
    : "unknown — no `-G` flag found in CC1FLAGS";

  const aspsxSentence = mk.aspsxVersion
    ? `configured MASPSX → GAS production protocol, ASPSX mode ${mk.aspsxVersion}. Source experiments use this unchanged route. Original compiler input is unknown; candidate expansion alone cannot establish what produced the original words`
    : "maspsx (\`tools/vendor/maspsx\`)";

  const out = `<!-- Auto-generated by tools/build/genProjectProfile.ts — do not edit manually.
     Human-supplied facts live in configs/project-info.json; toolchain facts
     configured choices come from toolchain.json; observations come from the target adapter. -->

# Project Profile — ${gameLine}

Concrete target and toolchain facts for agents working on this project.
Reusable guides and skills derive project-specific details from this file.
For a new project, update \`configs/project-info.json\` and the build
configuration, then regenerate this file.

## Target

- Project: ${gameLine}
- Platform: PlayStation 1 — MIPS R3000 (\`mips1\`), little-endian, GTE coprocessor
${exe ? `- PS-X EXE: load address \`${hex32(exe.loadAddr)}\`, entry \`${hex32(exe.entryPoint)}\`, \`$gp = ${hex32(exe.gpValue)}\``
  : `- Inputs: ${[...project!.target.archives, ...project!.target.standaloneObjects].map(p => `\`${p}\``).join(", ")} (ELF/ar)
- Identity: original member + symbol; coordinates: section + offset, not RAM
- Source ownership and acceptance: one original member/TU, including all neighboring functions/data and symbolic relocations
- Original assembly: per-function INCLUDE_ASM; generated data stays assembly-backed until recovered
- Available analysis: shared instruction/RTL diagnostics, staged residuals, schedule/allocation and loop analysis, callee checks, flag probes, source-shape search, context export, finalization and progress`}

- Iteration oracle scope: ${exe ? "function (relocated bytes)" : "owning translation unit (sections, symbols and relocations)"}

## Toolchain

${verifiedSentence}
- **Flags:** \`${mk.cc1Flags}\`
- **Small-data threshold:** ${gSentence}
- **Assembler semantics:** ${aspsxSentence}
- **SDK:** ${sdkLine}
${project ? `- **Owner profiles:** default \`${project.toolchainProfile ?? "toolchain containerProfiles.library/base"}\`; overrides: ${Object.entries(project.memberProfiles).map(([id, profile]) => `\`${id}\` → \`${profile}\``).join(", ") || "none"}
- **Preprocessor flags:** \`${configuredFlags("cpp", context).join(" ")}\`\n` : ""}${headersSection(project ? [
  ...project.headers.reference.map(path => ({ role: "reference declarations/types", path, readonly: true })),
  ...project.headers.owned.map(path => ({ role: "owned declarations/types", path })),
  { role: "generated m2c context only (not a compiler include)", path: "build/libraries/context/<member-id>/", generated: true },
] : info.headers)}
## Diagnostic and verification commands

${exe ? `- Structural classification: \`npx tsx tools/agent/explainDiff.ts <func>\`
- GCC pass/allocation trace: \`npx tsx tools/agent/compilerTrace.ts <func>\`` : `- Function-local instruction diagnostics: \`npx tsx tools/agent/inventory.ts <func>\`
- Target names: \`npm run identify -- --json\` (use the member-qualified key when names collide)`}
- Exact oracle: \`npx tsx tools/agent/diffFunc.ts <func>\` (\`VERDICT: MATCH\` verifies the scope above; \`UNDETERMINED\` is not a pass)
- Completion oracle: \`npm run check-all\` (${exe ? "SHA-256 against the original payload" : "every configured original member, including data-only objects"})
`;

  if (!write) {
    process.stdout.write(out);
    console.error("\n(dry run — pass --write to update configs/project-profile.md)");
    return;
  }

  writeIfChanged(OUT_PATH(), out);
  console.log(`Wrote ${OUT_PATH()}`);
  console.log(`  compiler: GCC ${mk.gccVersion}-psx, -G threshold: ${mk.gThreshold ?? "?"}, aspsx: ${mk.aspsxVersion ?? "?"}`);
  console.log(`  byte-identity: ${check.verified ? "VERIFIED" : "NOT VERIFIED"} (${check.detail})`);
}

if (process.argv[1]?.endsWith("genProjectProfile.ts")) generateProjectProfile(process.argv.slice(2));
