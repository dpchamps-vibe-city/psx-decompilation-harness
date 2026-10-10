#!/usr/bin/env npx tsx
/** Explicit library entry point. Generic npm/Pi commands use the same backend. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLibraryProject } from "../lib/project.js";
import { prepareLibraryFunction, measureLibraryFunction, renderLibraryComparison, runLibraryTask } from "./libraryTarget.js";

export async function main(args: string[]): Promise<void> {
  const [task, ...rest] = args;
  if (!task || task === "--help") {
    console.log("npm run library -- inventory|split|build|graph|progress [--json|--list|--remaining|--done]\n" +
      "npm run library -- prepare MEMBER::SYMBOL [--json]\n" +
      "npm run library -- diff MEMBER::SYMBOL [--src FILE]\n" +
      "npm run library -- check [--member ID | --accepted]\n" +
      "check without scope verifies EVERY configured member; --accepted is only an environment guard.");
    return;
  }
  if (!loadLibraryProject()) throw new Error("Configure a relocatable-library target in project.json first; see docs/library-targets.md");
  const allowed = task === "progress" ? ["--json", "--list", "--remaining", "--done", "--markdown"] :
    task === "check" ? ["--member", "--accepted"] : task === "prepare" ? ["--json"] : task === "diff" ? ["--src"] : [];
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!allowed.includes(arg)) throw new Error(`Unknown ${task} argument: ${arg}`);
    if (["--member", "--src"].includes(arg) && (!rest[++i] || rest[i]!.startsWith("--"))) throw new Error(`${arg} needs a value`);
  }
  if (["prepare", "diff"].includes(task)) {
    if (positional.length !== 1) throw new Error(`${task} needs one member::symbol target`);
    if (task === "prepare") {
      const result = await prepareLibraryFunction(positional[0]!);
      console.log(rest.includes("--json") ? JSON.stringify(result) : `Prepared packet: ${result.path}`);
    } else {
      const i = rest.indexOf("--src"), result = measureLibraryFunction(positional[0]!, i >= 0 ? rest[i + 1] : undefined);
      console.log(renderLibraryComparison(result.comparison));
      if (result.comparison.verdict !== "match") process.exitCode = 1;
    }
    return;
  }
  if (positional.length) throw new Error(`Unexpected ${task} arguments: ${positional.join(" ")}`);
  if (task === "check" && rest.includes("--accepted") && rest.includes("--member")) throw new Error("Choose --member or --accepted");
  runLibraryTask(task, rest);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
