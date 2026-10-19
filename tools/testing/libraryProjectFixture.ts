/**
 * A synthetic relocatable-library project (plans/optimization/00-measurement.md
 * §0.3): N hand-written members, each reconstructed as its own `.s` TU and
 * assembled by the production assembler, with an owned header and an optional
 * reference-header directory. No consumer data. Same toolchain prerequisites as
 * tools/agent/libraryCheck.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configuredCompilerSource, configuredTool, type ToolName } from "../lib/toolchain.js";
import { libraryMembers, type LibraryMember } from "../lib/libraryTargets.js";
import { ROOT, fixtureContext } from "./runtimeTestContext.js";

export interface LibraryProjectFixture { root: string; members: LibraryMember[]; assemble: (name: string, value: number) => void }

export function libraryProjectFixture(t: { after: (cleanup: () => void) => void }, count = 2, options: { referenceHeaders?: boolean } = {}): LibraryProjectFixture {
  const root = mkdtempSync(join(tmpdir(), "psx-library-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(ROOT, "toolchain.json"), "utf8"));
  for (const name of Object.keys(config.tools) as ToolName[]) config.tools[name] = configuredTool(name, ROOT);
  config.compiler.source = configuredCompilerSource(ROOT);
  config.includeDirs = options.referenceHeaders ? ["include", "reference"] : ["include"]; config.profiles = {}; config.containerProfiles = {};
  config.flags.as = config.flags.as.map((f: string) => f === "-G8" ? "-G0" : f);
  config.assembler = { kind: "gas" };
  mkdirSync(join(root, "include")); mkdirSync(join(root, "inputs"));
  writeFileSync(join(root, "include/owned.h"), "/* owned */\n");
  if (options.referenceHeaders) { mkdirSync(join(root, "reference"), { recursive: true }); writeFileSync(join(root, "reference/sdk.h"), "/* reference */\r\n"); }
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  const assembly = (symbol: string, value: number) =>
    `.set noreorder\n.text\n.globl ${symbol}\n.type ${symbol}, @function\n${symbol}:\n\tjr $ra\n\taddiu $v0, $zero, ${value}\n.size ${symbol}, .-${symbol}\n`;
  const names = Array.from({ length: count }, (_, i) => `fn${i}`);
  const assemble = (name: string, value: number) => {
    writeFileSync(join(root, `inputs/${name}.s`), assembly(name, value));
    execFileSync(config.tools.as, [...config.flags.as, join(root, `inputs/${name}.s`), "-o", join(root, `inputs/${name}.o`)]);
  };
  names.forEach((name, i) => assemble(name, i + 1));
  writeFileSync(join(root, "project.json"), JSON.stringify({ schemaVersion: 1,
    target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["inputs/*.o"] },
    headers: { reference: options.referenceHeaders ? ["reference"] : [], owned: ["include"], context: [] },
    output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "inputs" } }));
  const members = fixtureContext(root, () => libraryMembers(root));
  for (const member of members) {
    const name = member.functions[0]!.name, directory = join(root, dirname(member.source));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.s`), readFileSync(join(root, `inputs/${name}.s`), "utf8"));
    writeFileSync(join(root, member.source), JSON.stringify({ schemaVersion: 1, member: member.id, parts: [{ path: `${name}.s`, symbols: [name] }] }));
  }
  return { root, members, assemble };
}
