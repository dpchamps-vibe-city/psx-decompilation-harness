import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PARSERS, ParserRegistry, type AssetParser } from "./registry.js";
import { parserFingerprints } from "./fingerprints.js";
import { PARSER_CONFIG, PARSER_ROOT, parserPath, parserSourcePolicy } from "./parser-builder.js";
import { canonical, hash, safePath } from "./storage.js";
import type { ParserFingerprint } from "./types.ts";

/** Project capabilities are admitted separately from immutable built-in parsers.
 * Content-addressed runtime snapshots avoid stale ESM imports after edits, and
 * never write to an installed package or rewrite a project's authored files. */
export async function projectParsers(project: string): Promise<{ registry: ParserRegistry; fingerprints: ParserFingerprint[] }> {
  const fingerprints = parserFingerprints(PARSERS);
  if (!existsSync(safePath(project, PARSER_CONFIG))) return { registry: PARSERS, fingerprints };
  const files = readdirSync(safePath(project, PARSER_ROOT)).map(name => PARSER_ROOT + name).filter(path => parserPath(path) && !path.endsWith(".test.ts")).sort().map(path => {
    const bytes = readFileSync(safePath(project, path));
    parserSourcePolicy(path, bytes.toString());
    return { path, bytes, hash: hash(bytes) };
  });
  const key = hash(canonical(files.map(({path, hash}) => ({path, hash}))));
  const cache = safePath(project, `build/assets/cache/plugin-code/${key}`);
  mkdirSync(cache, { recursive: true });
  for (const file of files) {
    const output = resolve(cache, file.path.slice(PARSER_ROOT.length));
    if (!existsSync(output)) writeFileSync(output, file.bytes, { flag: "wx" });
    else if (hash(readFileSync(output)) !== file.hash) throw new Error("Corrupted parser runtime snapshot");
  }
  const plugins: unknown = (await import(pathToFileURL(resolve(cache, "parser-plugins.ts")).href)).EXTRA_PARSERS;
  if (!Array.isArray(plugins)) throw new Error("Project parser registry must export EXTRA_PARSERS");
  const registry = new ParserRegistry([...PARSERS.parsers, ...plugins as AssetParser[]]);
  for (const parser of plugins as AssetParser[]) fingerprints.push({ id: parser.id, format: parser.format, version: parser.version, hash: hash(canonical(["project-parser-v1", key, parser.id, parser.version])), files: files.map(({path, hash}) => ({path, hash})), specifications: parser.specifications ?? [] });
  return { registry, fingerprints: fingerprints.sort((a, b) => a.id.localeCompare(b.id, "en")) };
}
