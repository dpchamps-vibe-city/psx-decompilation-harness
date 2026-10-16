import { test, ROOT, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configuredTool, type ToolName } from "../lib/toolchain.js";
import { libraryMembers, type LibraryMember } from "../lib/libraryTargets.js";
import { libraryMembersOwning } from "../lib/libraryTranslationUnit.js";
import { checkLibrary } from "./libraryTarget.js";

/** Two hand-written members, each reconstructed as its own `.s` TU: the
 * smallest library whose check runs the production assembler and oracle. */
function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "psx-library-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(ROOT, "toolchain.json"), "utf8"));
  for (const name of Object.keys(config.tools) as ToolName[]) config.tools[name] = configuredTool(name, ROOT);
  config.includeDirs = ["include"]; config.profiles = {}; config.containerProfiles = {};
  config.flags.as = config.flags.as.map((f: string) => f === "-G8" ? "-G0" : f);
  config.assembler = { kind: "gas", inputRewrites: [] };
  mkdirSync(join(root, "include")); mkdirSync(join(root, "inputs"));
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  const assembly = (symbol: string, value: number) =>
    `.set noreorder\n.text\n.globl ${symbol}\n.type ${symbol}, @function\n${symbol}:\n\tjr $ra\n\taddiu $v0, $zero, ${value}\n.size ${symbol}, .-${symbol}\n`;
  const sources = { alpha: assembly("alpha", 1), beta: assembly("beta", 2) };
  for (const [name, text] of Object.entries(sources)) {
    writeFileSync(join(root, `inputs/${name}.s`), text);
    execFileSync(config.tools.as, [...config.flags.as, join(root, `inputs/${name}.s`), "-o", join(root, `inputs/${name}.o`)]);
  }
  writeFileSync(join(root, "project.json"), JSON.stringify({ schemaVersion: 1,
    target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["inputs/*.o"] },
    headers: { reference: [], owned: ["include"], context: [] },
    output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "inputs" } }));
  const members = libraryMembers(root), byName = (name: string) => members.find(m => m.input === `inputs/${name}.o`)!;
  for (const [name, text] of Object.entries(sources)) {
    const member = byName(name), directory = join(root, dirname(member.source));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.s`), text);
    writeFileSync(join(root, member.source), JSON.stringify({ schemaVersion: 1, member: member.id, parts: [{ path: `${name}.s`, symbols: [name] }] }));
  }
  return { root, alpha: byName("alpha"), beta: byName("beta") };
}

function check(t: { mock: { method: Function } }, args: string[], root: string): string[] {
  const lines: string[] = [], log = t.mock.method(console, "log", (line: string) => { lines.push(String(line)); });
  try { checkLibrary(args, root); } finally { log.mock.restore(); }
  return lines;
}
const reused = (lines: string[], member: LibraryMember) => lines.includes(`${member.id}: unchanged since its recorded whole-member match`);
const compiled = (lines: string[], member: LibraryMember) => lines.some(l => l.startsWith(`${member.id}: target:`) && l.includes("VERDICT: MATCH"));

test("the member gate stands on unchanged accepted records; everything else recompiles", t => {
  const f = fixture(t);
  fixtureContext(f.root, () => {
    let lines = check(t, [], f.root);
    assert(compiled(lines, f.alpha) && compiled(lines, f.beta), lines.join("\n"));

    lines = check(t, ["--member", f.alpha.id], f.root);
    assert(compiled(lines, f.alpha), "the active member always recompiles");
    assert(reused(lines, f.beta), lines.join("\n"));
    assert.match(lines.at(-1)!, /Verified 2 active\/previously accepted member\(s\) \(1 unchanged since their recorded match\)/);
    assert.deepEqual(readdirSync(join(f.root, "build/libraries/candidates", f.alpha.id)), [], "a passing compile leaves no artifacts");

    lines = check(t, ["--accepted"], f.root);
    assert(compiled(lines, f.alpha) && compiled(lines, f.beta), "the environment guard recompiles every accepted member");

    const betaSource = join(f.root, dirname(f.beta.source), "beta.s");
    writeFileSync(betaSource, readFileSync(betaSource, "utf8") + "# reconstructed\n");
    lines = check(t, ["--member", f.alpha.id], f.root);
    assert(compiled(lines, f.beta) && !reused(lines, f.beta), "a source edit changes the build identity");
    assert(reused(check(t, ["--member", f.alpha.id], f.root), f.beta), "the recompiled record is reusable again");

    mkdirSync(join(f.root, ".pi"), { recursive: true });
    writeFileSync(join(f.root, ".pi/autoloop.json"), JSON.stringify({ sourcePolicy: { allowEmptyMemoryBarrier: false } }));
    lines = check(t, ["--member", f.alpha.id], f.root);
    assert(compiled(lines, f.beta) && !reused(lines, f.beta), "a source-policy change re-audits every accepted member");
    assert(reused(check(t, ["--member", f.alpha.id], f.root), f.beta));

    const record = join(f.root, "build/libraries/verified", `${f.beta.id}.json`);
    writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), verificationKey: "another harness" }));
    assert(compiled(check(t, ["--member", f.alpha.id], f.root), f.beta), "a record from another harness is not reused");
  });
});

test("finalization reads only the TUs in directories it changed", t => {
  const f = fixture(t);
  fixtureContext(f.root, () => {
    const members = [f.alpha, f.beta], betaDir = dirname(f.beta.source);
    assert.deepEqual(libraryMembersOwning(members, [`${betaDir}/beta.s`], f.root).map(m => m.id), [f.beta.id]);
    assert.deepEqual(libraryMembersOwning(members, [f.beta.source], f.root).map(m => m.id), [f.beta.id]);
    assert.deepEqual(libraryMembersOwning(members, [`${betaDir}/notes.txt`, "include/common.h"], f.root), [], "an unlisted neighbor is not a TU source");
    // An untouched member's manifest is never opened, so it cannot fail the lookup.
    writeFileSync(join(f.root, f.alpha.source), "not json");
    assert.deepEqual(libraryMembersOwning(members, [`${betaDir}/beta.s`], f.root).map(m => m.id), [f.beta.id]);
    assert(existsSync(join(f.root, f.alpha.source)));
  });
});
