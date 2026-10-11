#!/usr/bin/env npx tsx
import { projectRoot } from "../lib/runtimeContext.js";
/** Recover colliding SDK members without last-write-wins extraction.
 * Usage: splitSdkLibs.ts [--write] [--converter /path/to/psyq2elf]
 *   [--sdk-dir tools/vendor/psyq47/LIB] [--version 470]
 * Existing non-colliding objects (including BSS patches) are not rewritten.
 * Generated objects/map are reproducible outputs, not checked-in artifacts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { collisionNames, hash, loadMemberMap, memberKey, readAr, readPsyqLib, readTextObject, signatureFits, signatureId, type MemberMap, type MemberRecord, type SigEntry } from "../lib/psyqMembers.js";

import { fileDigest, digest } from "../lib/contentCache.js";
import { configuredSdk, configuredTool, loadToolchain } from "../lib/toolchain.js";

export interface SplitOptions { root: string; sdkDir: string; version: string; converter?: string; convertedDir?: string; signatures?: string; write: boolean }
function writeChanged(file: string, bytes: Buffer | string): void {
  const data = Buffer.from(bytes);
  if (existsSync(file) && readFileSync(file).equals(data)) return;
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, data);
}

export function splitSdkLibs(options: SplitOptions): MemberMap {
  const { root, sdkDir, version, write } = options;
  if (!/^\d+$/.test(version)) throw new Error("SDK version must be a numeric directory name");
  const sigDir = options.signatures ?? configuredSdk(root).signatures;
  const fingerprint = digest(JSON.stringify({ algorithm: "sdk-members-v2", version, converter: options.converter ? fileDigest(options.converter) : "absent",
    archives: readdirSync(sdkDir).filter(f => /\.(LIB|a)$/.test(f)).sort().map(f => [f, fileDigest(join(sdkDir, f))]),
    signatures: readdirSync(sigDir).filter(f => f.endsWith(".LIB.json")).sort().map(f => [f, fileDigest(join(sigDir, f))]) }));
  const previous = loadMemberMap(root, version);
  if (previous?.inputsFingerprint === fingerprint && previous.members.every(m => m.objectHash && fileDigest(join(root, m.oPath)) === m.objectHash)) return previous;
  const scratch = mkdtempSync(join(tmpdir(), "psyq-members-"));
  const map: MemberMap = { schemaVersion: 1, version, inputsFingerprint: fingerprint, members: [], signatures: [] };
  const pending = new Map<string, Buffer>();
  const converterIdentity = options.converter ? { sha256: hash(readFileSync(options.converter)), mode: "supplied" as const } : undefined;
  try {
    for (const file of readdirSync(sdkDir).filter(f => /\.(LIB|a)$/.test(f)).sort()) {
      const source = join(sdkDir, file), archive = readFileSync(source);
      const archiveHash = hash(archive);
      const original = /\.LIB$/i.test(file);
      const members = original ? readPsyqLib(archive) : readAr(archive);
      const collisions = collisionNames(members);
      const lib = basename(file).replace(/\.(LIB|a)$/i, "").toLowerCase();
      const used = new Map<string, string>();
      for (const member of members) {
        const key = memberKey(member.name), collision = collisions.has(key);
        let oPath = `${relative(root, resolve(root, options.convertedDir ?? "lib"))}/${lib}/${key}.o`;
        let elf: Buffer;
        const converter = original ? converterIdentity : undefined;
        let memberConverter: MemberRecord["converter"];
        if (original) {
          // Reuse only an ordinal+content-identified member, never a bare name.
          const cached = previous?.members.find(m => m.source === relative(root, source) && m.ordinal === member.ordinal && m.sourceHash === hash(member.bytes));
          if (cached && existsSync(join(root, cached.oPath)) &&
              (!cached.objectHash || cached.objectHash === hash(readFileSync(join(root, cached.oPath)))) &&
              (!cached.converter || cached.converter.mode === "preexisting-elf" || cached.converter.sha256 === converter?.sha256)) {
            elf = readFileSync(join(root, cached.oPath));
            memberConverter = cached.converter;
          } else if (!collision && !cached && existsSync(join(root, oPath))) {
            // Preserve supplied/verified legacy non-colliding ELF inputs, including
            // BSS corrections. They are explicitly identified as pre-existing.
            elf = readFileSync(join(root, oPath));
          } else {
            // Convert independently, BEFORE choosing a symbol-qualified filename.
            if (!options.converter) throw new Error(`${file}:${member.name}: original PSY-Q member requires toolchain.json.tools.psyq2elf or an explicit converter`);
            const input = join(scratch, `${member.ordinal}.OBJ`), output = join(scratch, `${member.ordinal}.o`);
            writeFileSync(input, member.bytes);
            execFileSync(options.converter, [input, output], { stdio: ["ignore", "pipe", "pipe"] });
            elf = readFileSync(output);
            memberConverter = converter;
          }
        } else elf = member.bytes;

        let symbols: MemberRecord["symbols"] = [];
        try { symbols = readTextObject(elf).symbols; } catch (error) {
          if (collision) throw error; // A collision without inspectable .text cannot be named safely.
        }
        if (collision) {
          const first = symbols[0]?.name ?? hash(member.bytes).slice(0, 12);
          const safe = first.replace(/[^\w.-]/g, "_");
          oPath = `${relative(root, resolve(root, options.convertedDir ?? "lib"))}/sdk/${version}/${lib}/${key}__${safe}.o`;
          if (used.has(oPath) && used.get(oPath) !== hash(member.bytes)) oPath = oPath.replace(/\.o$/, `__${hash(member.bytes).slice(0, 12)}.o`);
          pending.set(oPath, elf);
        } else {
          if (!existsSync(join(root, oPath))) oPath = `${relative(root, resolve(root, options.convertedDir ?? "lib"))}/sdk/${version}/${lib}/${key}.o`;
          pending.set(oPath, elf);
        }
        if (existsSync(join(root, oPath)) && !readFileSync(join(root, oPath)).equals(elf)) {
          throw new Error(`Refusing to overwrite different project library object: ${oPath}`);
        }
        const identity = hash(member.bytes);
        if (used.has(oPath) && used.get(oPath) !== identity) throw new Error(`Output collision ${oPath}`);
        used.set(oPath, identity);
        map.members.push({ source: relative(root, source), member: member.name, ordinal: member.ordinal, sourceOffset: member.offset,
          sourceHash: identity, archiveHash, objectHash: hash(elf),
          converter: memberConverter ?? { sha256: hash(elf), mode: original ? "preexisting-elf" : "elf-ar" }, symbols, oPath, collision });
      }
    }
    for (const sigFile of readdirSync(sigDir).filter(f => f.endsWith(".LIB.json")).sort()) {
      const lib = sigFile.replace(/\.LIB\.json$/i, "").toLowerCase();
      const entries: SigEntry[] = JSON.parse(readFileSync(join(sigDir, sigFile), "utf8"));
      for (const entry of entries) {
        const records = map.members.filter(m => basename(m.source).replace(/\.(LIB|a)$/i, "").toLowerCase() === lib && memberKey(m.member) === memberKey(entry.name));
        const paths = [...new Set(records.map(m => m.oPath))];
        const matches = paths.filter(p => {
          try { return signatureFits(entry, readTextObject(pending.get(p) ?? readFileSync(join(root, p)))); } catch { return false; }
        });
        if (matches.length === 1) map.signatures.push({ sigFile, identity: signatureId(entry), oPath: matches[0]! });
        else if (records.some(m => m.collision)) throw new Error(`Cannot uniquely map ${sigFile}:${entry.name} (${entry.labels?.[0]?.name}): ${matches.length} verified objects`);
      }
    }
    if (write) {
      for (const [oPath, elf] of pending) writeChanged(join(root, oPath), elf);
      writeChanged(join(root, "build/sdk", `member-map-${version}.json`), JSON.stringify(map, null, 2) + "\n");
    }
    return map;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
function main(): void {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string): string => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Missing value for ${name}`);
    return args[i + 1]!;
  };
  const sdk = configuredSdk();
  const converter = option("--converter", loadToolchain().tools.psyq2elf ? configuredTool("psyq2elf") : "");
  const map = splitSdkLibs({ root: projectRoot(), sdkDir: option("--sdk-dir", sdk.originalDir), version: option("--version", sdk.version), convertedDir: sdk.convertedDir, signatures: sdk.signatures, write: args.includes("--write"), ...(converter ? { converter } : {}) });
  const collisionPaths = new Set(map.members.filter(m => m.collision).map(m => m.oPath));
  console.log(`${args.includes("--write") ? "Wrote" : "Dry run:"} SDK ${map.version}: ${map.members.length} members, ${collisionPaths.size} collision-safe objects, ${map.signatures.length} signature mappings`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
