#!/usr/bin/env npx tsx
/** Explicit library entry point. Generic npm/Pi commands use the same backend. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLibraryProject } from "../lib/project.js";
import { prepareLibraryFunction, measureLibraryFunction, renderLibraryComparison, runLibraryTask } from "./libraryTarget.js";
import { preflightLibraryFunction, checkLibrarySplits } from "./libraryPreflight.js";
import { migrateMemberIds } from "./migrateMemberIds.js";
import { retainHandwrittenAssembly } from "./retainHandwrittenAssembly.js";
import { libraryCodeClassCensus, renderCodeClassCensus } from "./libraryCodeClasses.js";
import { reformLibraryTus } from "./reformLibraryTu.js";
import { FOLD_STATUS, foldLibraryTus } from "./foldLibraryTu.js";

export async function main(args: string[]): Promise<void> {
  const [task, ...rest] = args;
  if (!task || task === "--help") {
    console.log("npm run library -- inventory|split|build|graph|progress [--json|--list|--remaining|--done]\n" +
      "npm run library -- prepare MEMBER::SYMBOL [--json]\n" +
      "npm run library -- preflight MEMBER::SYMBOL [--json] (real-member setup/split/preparation check, not C completion)\n" +
      "npm run library -- check-splits [--json] (all original assembly splits only, not live C)\n" +
      "npm run library -- diff MEMBER::SYMBOL [--src FILE]\n" +
      "npm run library -- check [--member ID | --accepted]\n" +
      "npm run library -- migrate-member-ids [--write] [--json] (dry-run by default)\n" +
      "npm run library -- retain-handwritten [--write] [--json] (verbatim extraction; no assembly reconstruction)\n" +
      "npm run library -- code-classes [--json] (read-only hand-written fingerprint census and its validation gate)\n" +
      "npm run library -- reform [--member ID ...] [--write] [--json] (assembly TU of a GCC-compiled member -> C parts; dry-run by default)\n" +
      "npm run library -- fold [--member ID ... | --all-ready] [--write] [--json] (finished C TU -> one module; check by default)\n" +
      "check without scope verifies EVERY configured member; --accepted is only an environment guard.");
    return;
  }
  if (!loadLibraryProject()) throw new Error("Configure a relocatable-library target in project.json first; see docs/library-targets.md");
  if (task === "retain-handwritten") {
    if (rest.some(a => !["--write", "--json"].includes(a))) throw new Error("retain-handwritten accepts only --write and --json");
    const report = retainHandwrittenAssembly(rest.includes("--write"));
    console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : `${report.written ? "Retained" : "Dry run:"} ${report.members.length} handwritten-assembly members (${report.members.reduce((n, m) => n + m.functions.length, 0)} functions); extracted files are copied unchanged, not reconstructed.`);
    return;
  }
  if (task === "fold") {
    const ids = rest.flatMap((a, i) => a === "--member" ? [rest[i + 1] ?? ""] : []);
    if (rest.some((a, i) => !["--write", "--json", "--member", "--all-ready"].includes(a) && rest[i - 1] !== "--member") || ids.some(id => !id || id.startsWith("--")))
      throw new Error("fold accepts --member ID (repeatable), --all-ready, --write and --json");
    const report = foldLibraryTus(rest.includes("--write"), ids);
    console.log(rest.includes("--json") ? FOLD_STATUS + JSON.stringify(report) : [
      `${report.written ? "Fold" : "Fold check"}: ${report.members.filter(m => m.verdict === "match").length}/${report.members.length} modules rebuild the original object${report.written ? `; ${report.members.filter(m => m.written).length} written` : ""}`,
      ...report.members.map(m => `  ${m.written ? "FOLDED" : m.refused ? "REFUSED" : m.verdict === "match" ? "READY" : "MISMATCH"}\t${m.id}\t${m.module}${m.refused ? `\t${m.refused}` : ""}`),
    ].join("\n"));
    if (report.members.some(m => m.verdict && m.verdict !== "match")) process.exitCode = 1;
    return;
  }
  if (task === "reform") {
    const ids = rest.flatMap((a, i) => a === "--member" ? [rest[i + 1] ?? ""] : []);
    if (rest.some((a, i) => !["--write", "--json", "--member"].includes(a) && rest[i - 1] !== "--member") || ids.some(id => !id || id.startsWith("--")))
      throw new Error("reform accepts --member ID (repeatable), --write and --json");
    const report = reformLibraryTus(rest.includes("--write"), ids);
    console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : [
      `${report.written ? "Reformed" : "Dry run:"} ${report.members.length} assembly TUs of GCC-compiled members into C parts`,
      ...report.members.map(m => `  ${m.id}: removes ${m.removed.join(", ")}${report.written ? `; parts ${m.parts.join(", ")}; retained ${m.retained.join(", ") || "none"}` : ""}`),
      ...(report.written && report.members.length ? ["Run `npm run graph` (or split) to refresh the call graph."] : []),
    ].join("\n"));
    return;
  }
  if (task === "code-classes") {
    if (rest.some(a => a !== "--json")) throw new Error("code-classes accepts only --json");
    const census = libraryCodeClassCensus();
    console.log(rest.includes("--json") ? JSON.stringify(census, null, 2) : renderCodeClassCensus(census));
    if (census.failures.length) process.exitCode = 1;
    return;
  }
  if (task === "migrate-member-ids") {
    if (rest.some(a => !["--write", "--json"].includes(a))) throw new Error("migrate-member-ids accepts only --write and --json");
    const report = migrateMemberIds(rest.includes("--write"));
    console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : [
      `${report.written ? "Migrated" : "Dry run:"} ${Object.keys(report.mapping).length} member IDs`,
      ...report.changes.map(c => `${c.regenerate ? "Regenerate: " : ""}${c.path}${c.path !== c.destination ? ` -> ${c.destination}` : ""}: ${c.occurrences} occurrences`),
      ...report.invalidated.map(p => `Invalidate: ${p}`),
      "Run split to regenerate reference fragments/graph, then check-all under the new IDs before resuming the autoloop.",
    ].join("\n"));
    return;
  }
  const allowed = task === "check-splits" ? ["--json"] : task === "progress" ? ["--json", "--list", "--remaining", "--done", "--markdown"] :
    task === "check" ? ["--member", "--accepted"] : ["prepare", "preflight"].includes(task) ? ["--json"] : task === "diff" ? ["--src"] : [];
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!allowed.includes(arg)) throw new Error(`Unknown ${task} argument: ${arg}`);
    if (["--member", "--src"].includes(arg) && (!rest[++i] || rest[i]!.startsWith("--"))) throw new Error(`${arg} needs a value`);
  }
  if (["prepare", "diff", "preflight"].includes(task)) {
    if (positional.length !== 1) throw new Error(`${task} needs one member::symbol target`);
    if (task === "preflight") {
      const result = await preflightLibraryFunction(positional[0]!);
      console.log(rest.includes("--json") ? JSON.stringify(result) : [
        `${result.target}: setup ${result.status.toUpperCase()} (not decompilation completion)`,
        ...result.stages.map(s => `  ${s.status.toUpperCase()}: ${s.name} — ${s.detail}`), `Report: ${result.report}`,
      ].join("\n"));
      if (result.status !== "passed") process.exitCode = 1;
    } else if (task === "prepare") {
      const result = await prepareLibraryFunction(positional[0]!);
      console.log(rest.includes("--json") ? JSON.stringify(result) : `Prepared packet: ${result.path}`);
    } else {
      const i = rest.indexOf("--src"), result = measureLibraryFunction(positional[0]!, i >= 0 ? rest[i + 1] : undefined);
      console.log(renderLibraryComparison(result.comparison, result.functionComparison));
      if (result.comparison.verdict !== "match") process.exitCode = 1;
    }
    return;
  }
  if (positional.length) throw new Error(`Unexpected ${task} arguments: ${positional.join(" ")}`);
  if (task === "check-splits") {
    const result = checkLibrarySplits(), failures = result.members.filter(m => m.verdict !== "match");
    console.log(rest.includes("--json") ? JSON.stringify(result) : [
      `Original assembly splits: ${result.status.toUpperCase()} (${result.members.length - failures.length}/${result.members.length} members)`,
      "Scope: generated reference assembly only; live C and decompilation completion are NOT certified.",
      ...failures.map(m => `${m.id}: ${m.differences.join("; ")}`), `Report: ${result.report}`,
    ].join("\n"));
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }
  if (task === "check" && rest.includes("--accepted") && rest.includes("--member")) throw new Error("Choose --member or --accepted");
  runLibraryTask(task, rest);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
