/** Small, isolated PS-X EXE/overlay projects. No game assets, generated build
 * from another checkout, or mutation of the harness's active configuration. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredTool, HARNESS_ROOT, type ToolName, type ToolchainConfig } from "../lib/toolchain.js";
import { loadContainers, resetContainerCache } from "../lib/container.js";

export interface FixtureFunction { name: string; offset: number; words: readonly number[] }
export const FIXTURE_BASE = 0x80024000;
export const FIXTURE_OVERLAY_BASE = 0x80140000;
export const FIXTURE_GP = 0x8002bff0;
export const SDK_BANNER = "Library Programs (c) 1993-1997 Sony Computer Entertainment Inc.";

export function projectFixture(t: { after: (cleanup: () => void) => void }, options: {
  root?: string;
  assemblies?: boolean;
  vendorString?: string;
  exe?: readonly FixtureFunction[];
  overlays?: Readonly<Record<string, readonly FixtureFunction[]>>;
} = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "psx-project-fixture-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); resetContainerCache(); });
  const put = (path: string, data: string | Buffer) => {
    mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), data);
  };
  const defaultCode: FixtureFunction[] = [{ name: "fixture_entry", offset: 0, words: [
    0x3c1c8003, 0x279cbff0, 0x03e00008, 0,
  ] }];
  const exe = options.exe ?? defaultCode;
  const overlays = options.overlays ?? { ovl_fixture: [{ name: "ovl_fixture_helper", offset: 0, words: [0x03e00008, 0] }] };
  const image = (functions: readonly FixtureFunction[], offset: number, base: number, banner?: string) => {
    const codeEnd = Math.max(4, ...functions.map(f => f.offset + f.words.length * 4));
    const data = Buffer.from((banner ?? "fixture data") + "\0", "latin1");
    const payloadSize = Math.ceil((codeEnd + data.length) / 4) * 4;
    const bytes = Buffer.alloc(offset + payloadSize);
    if (offset) {
      bytes.write("PS-X EXE"); bytes.writeUInt32LE(base, 0x10);
      bytes.writeUInt32LE(base, 0x18); bytes.writeUInt32LE(payloadSize, 0x1c);
    }
    for (const f of functions) f.words.forEach((word, i) => bytes.writeUInt32LE(word >>> 0, offset + f.offset + i * 4));
    data.copy(bytes, offset + codeEnd);
    return { bytes, codeEnd, payloadSize };
  };
  const writeContainer = (id: string, functions: readonly FixtureFunction[], offset: number, base: number, banner?: string) => {
    const { bytes, codeEnd, payloadSize } = image(functions, offset, base, banner);
    const target = id === "exe" ? "extracted/FIXTURE.EXE" : `extracted/overlays/${id}.bin`;
    const build = id === "exe" ? "build" : `build/${id}`;
    const yaml = id === "exe" ? "configs/splat/exe.yaml" : `configs/splat/${id}.yaml`;
    put(target, bytes);
    put(yaml, `options:\n  target_path: ${target}\n  basename: fixture_image\n  compiler: PSYQ\n  gp_value: 0x${FIXTURE_GP.toString(16)}\nsegments:\n  - name: code\n    start: 0x${offset.toString(16)}\n    vram: 0x${base.toString(16)}\n    subsegments:\n` +
      functions.flatMap((f, i) => {
        const segment = `      - [0x${(offset + f.offset).toString(16)}, asm, ${f.name}]`;
        const end = f.offset + f.words.length * 4;
        /* A gap is fixture data, not trailing instructions in the preceding
         * function. The byte oracle uses subsegment boundaries for spans. */
        return i + 1 < functions.length && end < functions[i + 1]!.offset
          ? [segment, `      - [0x${(offset + end).toString(16)}, .data]`] : [segment];
      }).join("\n") +
      `\n      - [0x${(offset + codeEnd).toString(16)}, .data]\n  - [0x${bytes.length.toString(16)}]\n`);
    put(`configs/symbols/${id}.txt`, functions.map(f => `${f.name} = 0x${(base + f.offset).toString(16)};`).join("\n") + "\n");
    put(`${build}/functions.csv`, "rom,vram,name,type,size\n" + functions.map(f => `${offset + f.offset},${base + f.offset},${f.name},function,${f.words.length * 4}`).join("\n") + "\n");
    put(`${build}/sectionLayout.json`, JSON.stringify({ rodataStart: offset, textStart: offset, dataStart: offset + codeEnd, sdataStart: offset + codeEnd, fileEnd: bytes.length }));
    for (const f of options.assemblies === false ? [] : functions) {
      put(`${build}/asm/nonmatchings/${f.name}/${f.name}.s`, `glabel ${f.name}\n/* ${(offset + f.offset).toString(16)} ${(base + f.offset).toString(16)} 00000000 */ nop\n`);
    }
    return { size: payloadSize, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  writeContainer("exe", exe, 0x800, FIXTURE_BASE, options.vendorString);
  const members = Object.entries(overlays).map(([id, functions], index) => {
    const { size, sha256 } = writeContainer(id, functions, 0, FIXTURE_OVERLAY_BASE);
    return { id, index, offset: 0, end: size, size, sector: 0, sectorCount: 1, tag: "0x0", sha256,
      classification: { verdict: "code", format: null, evidence: ["synthetic instruction stream"] },
      base: { verdict: "resolved", base: FIXTURE_OVERLAY_BASE, loadOffset: 0, margin: 1, evidence: ["fixture geometry"] } };
  });
  put("configs/overlays.json", JSON.stringify({ generatedBy: "synthetic fixture", archive: {}, members }));
  const config: ToolchainConfig = JSON.parse(readFileSync(join(HARNESS_ROOT, "toolchain.json"), "utf8"));
  for (const name of Object.keys(config.tools) as ToolName[]) config.tools[name] = configuredTool(name);
  config.profiles = { fixture_overlay: { cc1: config.flags.cc1.filter(f => !/^-G/.test(f)).concat("-G0"), as: config.flags.as.filter(f => !/^-G/.test(f)).concat("-G0") } };
  config.containerProfiles = { overlay: "fixture_overlay" }; config.fileFlags = {};
  put("toolchain.json", JSON.stringify(config));
  return { root, put, containers: () => loadContainers(root), toolchain: config };
}

/** Seed an already-owned temporary workspace (its test controls cleanup). */
export function seedProjectFixture(root: string): void {
  projectFixture({ after: () => {} }, { root, assemblies: false });
}
