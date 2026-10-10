import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { inferTypesFromBinary, type SymbolInfo } from "../build/classifyGlobals.js";
import type { PsxExeInfo, SectionLayout } from "./psxExeInfo.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = import.meta.resolve("tsx");
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

function temporaryProject(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "psx-harness-agnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function syntheticExe(): Buffer {
  const bytes = Buffer.alloc(0x900);
  bytes.write("PS-X EXE", 0, "ascii");
  bytes.writeUInt32LE(0x80030000, 0x10);
  bytes.writeUInt32LE(0x80038000, 0x14);
  bytes.writeUInt32LE(0x80030000, 0x18);
  bytes.writeUInt32LE(0x100, 0x1c);
  bytes.writeUInt32LE(0x801f0000, 0x30);
  return bytes;
}

function scanFixture(t: TestContext): { bytes: Buffer; info: PsxExeInfo; layout: SectionLayout } {
  const root = temporaryProject(t);
  const bytes = syntheticExe();
  const binaryPath = join(root, "unrelated-title.exe");
  const info: PsxExeInfo = {
    binaryPath, loadAddr: 0x80030000, entryPoint: 0x80030000,
    payloadOffset: 0x800, payloadSize: 0x100, gpValue: 0x80038000, fileEnd: 0x900,
  };
  const layout: SectionLayout = {
    rodataStart: 0x800, textStart: 0x820, dataStart: 0x840, sdataStart: 0x880, fileEnd: 0x900,
  };
  writeFileSync(binaryPath, bytes);
  return { bytes, info, layout };
}

const symbol = (name = "D_80031000"): SymbolInfo => ({ name, addr: 0x80031000, inGpRange: true, cType: "s32" });
const luiT0 = 0x3c088003;
const lbuFromT0 = 0x91091000;
const lhFromT0 = 0x85091000;

test("active scaffolding contains roles, not inherited target facts", () => {
  assert.deepEqual(Object.keys(json("configs/project-info.json")), ["headers"]);
  for (const path of ["include/common.h", "include/globals.h", "include/globals_override.h", "include/game_types.h", "toolchain.json", "tools/lib/toolchain.schema.json"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, path), "utf8"), /SLUS[_-]011|ovl_11|D_800[0-9a-f]{5}|Btn[A-Z]/i, path);
  }
  for (const path of ["configs/splat.yaml", "configs/splat", "configs/symbol_addrs.txt", "configs/symbols", "configs/overlays.json", "configs/project-profile.md"]) {
    assert.equal(existsSync(join(ROOT, path)), false, `${path} is not active example evidence`);
  }
  assert.ok(existsSync(join(ROOT, "examples/btn-decompilation/configs")));
  assert.ok(existsSync(join(ROOT, "examples/btn-decompilation/include/common.h")));
});

test("active policy copies no game-specific exemptions or commit authorization", () => {
  const config = json(".pi/autoloop.json");
  assert.deepEqual(config.sourcePolicy.allowlist, {});
  assert.equal(config.commitOnMatch, false);
  assert.equal(config.commitOnPark, false);
  assert.equal(config.integration.allowCommits, false);
  assert.ok(existsSync(join(ROOT, "examples/btn-decompilation/.pi/autoloop.json")));
});

test("unused reference vendors are excluded", () => {
  for (const vendor of ["silent-hill-decomp", "homebrew-psyq", "psyq_sdk"]) {
    assert.equal(existsSync(join(ROOT, "tools/vendor", vendor)), false, vendor);
  }
});

test("retained submodules are independent and pinned", () => {
  const pins: Record<string, string> = {
    "old-gcc": "c8c4b40f105375d575c030b28f23d6370d676268",
    maspsx: "0249ed2752a100eed95e8b4124f94af859398ca9",
    m2c: "cd96c559d54ea8644177e89cee07e4f0b0ac4825",
    psx_psyq_signatures: "e9e46e7e133ef275a79bfce650924f98edb086bc",
  };
  for (const [name, pin] of Object.entries(pins)) {
    const checkout = join(ROOT, "tools/vendor", name);
    const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
    assert.equal(git("rev-parse", "HEAD"), pin, name);
    const gitDir = realpathSync(git("rev-parse", "--absolute-git-dir"));
    assert.ok(gitDir.startsWith(realpathSync(ROOT) + "/.git/"), `${name} git metadata is local`);
    assert.equal(existsSync(join(gitDir, "objects/info/alternates")), false, `${name} borrows no object database`);
    assert.match(git("remote", "get-url", "origin"), /^https:\/\/github\.com\//, `${name} has upstream origin`);
  }
});

test("headerInfo accepts an arbitrary executable filename and load/stack values", (t) => {
  const root = temporaryProject(t);
  const binary = join(root, "different-game.exe");
  const output = join(root, "reports/header.md");
  writeFileSync(binary, syntheticExe());
  execFileSync(process.execPath, ["--import", TSX, join(ROOT, "tools/diagnostics/headerInfo.ts"), binary, output], { cwd: root });
  const report = readFileSync(output, "utf8");
  assert.match(report, /^# different-game\.exe PS-X EXE Header Analysis/);
  assert.match(report, /0x80030000/);
  assert.match(report, /0x801F0000/);
  assert.doesNotMatch(report, /SLUS_011|Back to Nature/i);
});

test("headerInfo help needs no target and invalid inputs fail", (t) => {
  const root = temporaryProject(t);
  const args = ["--import", TSX, join(ROOT, "tools/diagnostics/headerInfo.ts")];
  const help = execFileSync(process.execPath, [...args, "--help"], { cwd: root, encoding: "utf8" });
  assert.match(help, /Usage:/);
  for (const [name, bytes, diagnostic] of [
    ["short.exe", Buffer.alloc(10), /file too small/],
    ["wrong.exe", Buffer.alloc(0x800), /not a PS-X EXE/],
  ] as const) {
    writeFileSync(join(root, name), bytes);
    const result = spawnSync(process.execPath, [...args, name, "report.md"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.equal(existsSync(join(root, "report.md")), false);
  }
});

test("EXE discovery/configuration derives non-BTN names and refuses missing layout", (t) => {
  // Copy the actual module into an isolated project: no fixture game or ROOT mutation.
  const root = temporaryProject(t);
  mkdirSync(join(root, "tools/lib"), { recursive: true });
  mkdirSync(join(root, "extracted/subdir"), { recursive: true });
  mkdirSync(join(root, "configs"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  copyFileSync(join(ROOT, "tools/lib/psxExeInfo.ts"), join(root, "tools/lib/psxExeInfo.ts"));
  writeFileSync(join(root, "extracted/subdir/OTHER.EXE"), syntheticExe());
  writeFileSync(join(root, "extracted/decoy.bin"), Buffer.alloc(0x800));
  const runner = join(root, "probe.ts");
  writeFileSync(runner, `import { loadPsxExeInfo, exeBasename, requireSectionLayout } from "./tools/lib/psxExeInfo.js";
const info = loadPsxExeInfo();
let layoutError = "";
try { requireSectionLayout(); } catch (error) { layoutError = error.message; }
console.log(JSON.stringify({ basename: exeBasename(), loadAddr: info.loadAddr, binaryPath: info.binaryPath, layoutError }));\n`);
  const probe = () => JSON.parse(execFileSync(process.execPath, ["--import", TSX, runner], { cwd: root, encoding: "utf8" }));
  const discovered = probe();
  assert.equal(discovered.basename, "OTHER");
  assert.equal(discovered.loadAddr, 0x80030000);
  assert.equal(discovered.binaryPath, join(root, "extracted/subdir/OTHER.EXE"));
  assert.match(discovered.layoutError, /sectionLayout\.json not found/);
  writeFileSync(join(root, "configs/splat.yaml"), "options:\n  target_path: extracted/subdir/OTHER.EXE\n  basename: independent_target\n");
  assert.equal(probe().basename, "independent_target");
});

test("global inference scans measured text at a different load address", (t) => {
  const { bytes, info, layout } = scanFixture(t);
  bytes.writeUInt32LE(luiT0, layout.textStart);
  bytes.writeUInt32LE(lbuFromT0, layout.textStart + 4);
  writeFileSync(info.binaryPath, bytes);
  const symbols: [SymbolInfo] = [symbol()];
  inferTypesFromBinary(symbols, info, layout);
  assert.equal(symbols[0].cType, "u8");
  assert.equal(symbols[0].inGpRange, false);
});

test("global inference does not scan pre-text bytes or data as instructions", (t) => {
  const { bytes, info, layout } = scanFixture(t);
  for (const offset of [layout.rodataStart, layout.dataStart]) {
    bytes.writeUInt32LE(luiT0, offset);
    bytes.writeUInt32LE(lbuFromT0, offset + 4);
  }
  writeFileSync(info.binaryPath, bytes);
  const symbols: [SymbolInfo] = [symbol()];
  inferTypesFromBinary(symbols, info, layout);
  assert.equal(symbols[0].cType, "s32");
  assert.equal(symbols[0].inGpRange, true);
});

test("global inference's lookahead stops at the measured text end", (t) => {
  const { bytes, info, layout } = scanFixture(t);
  bytes.writeUInt32LE(luiT0, layout.dataStart - 4);
  bytes.writeUInt32LE(lhFromT0, layout.dataStart);
  writeFileSync(info.binaryPath, bytes);
  const symbols: [SymbolInfo] = [symbol()];
  inferTypesFromBinary(symbols, info, layout);
  assert.equal(symbols[0].cType, "s32");
  assert.equal(symbols[0].inGpRange, true);
});

test("global inference rejects unaligned, reversed, fractional and out-of-payload bounds", (t) => {
  const { info, layout } = scanFixture(t);
  for (const invalid of [
    { textStart: 0x7fc }, { textStart: 0x821 }, { textStart: 0x820 + 0.5 },
    { dataStart: 0x81c }, { dataStart: 0x841 }, { dataStart: 0x904 },
    { textStart: undefined }, { dataStart: Number.NaN },
  ]) {
    assert.throws(() => inferTypesFromBinary([symbol()], info, { ...layout, ...invalid } as SectionLayout), /Invalid target \.text bounds/);
  }
  assert.throws(() => inferTypesFromBinary([symbol()], { ...info, fileEnd: 0x83c }, layout), /Invalid target \.text bounds/);
  writeFileSync(info.binaryPath, syntheticExe().subarray(0, 0x830));
  assert.throws(() => inferTypesFromBinary([symbol()], info, layout), /Invalid target \.text bounds/);
});
