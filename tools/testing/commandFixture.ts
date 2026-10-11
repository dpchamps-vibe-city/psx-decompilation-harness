/** Process-oracle fixture. Intercepts only an installed internal dispatch in
 * test child processes; production tools/CLIs have no hook or obsolete alias. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT } from "../lib/runtimeContext.js";
export function installedCommandFixture(t: { after(action: () => void): void }, root: string, entries: Record<string, string>): void {
  const previous = process.env.NODE_OPTIONS;
  const directory = join(root, "build/test-command-fixtures"); mkdirSync(directory, { recursive: true });
  const map: Record<string, string> = {};
  for (const [entry, source] of Object.entries(entries)) {
    const file = join(directory, entry.replaceAll("/", "_").replace(/\.ts$/, ".ts")); writeFileSync(file, source); map[join(HARNESS_ROOT, entry)] = file;
  }
  const preload = join(directory, "oracle.cjs");
  writeFileSync(preload, `const {spawnSync}=require('node:child_process');
const index=process.argv.findIndex(a=>a===${JSON.stringify(join(HARNESS_ROOT, "tools/lib/scriptHost.ts"))});
const mapping=${JSON.stringify(map)};
if(index>=0&&mapping[process.argv[index+1]]) {
 const env={...process.env}; delete env.NODE_OPTIONS;
 const result=spawnSync(process.execPath,['--import',${JSON.stringify(join(HARNESS_ROOT, "node_modules/tsx/dist/loader.mjs"))},mapping[process.argv[index+1]],...process.argv.slice(index+4)],{cwd:process.cwd(),env,stdio:'inherit'});
 if(result.error)throw result.error;process.exit(result.status??1);
}\n`);
  process.env.NODE_OPTIONS = `${previous ?? ""} --require ${JSON.stringify(preload)}`.trim();
  t.after(() => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; });
}
