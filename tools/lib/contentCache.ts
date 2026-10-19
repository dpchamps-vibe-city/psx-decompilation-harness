import { AsyncLocalStorage } from "node:async_hooks";
/** Content-addressed caches: missing inputs and directory membership are facts.
 * Publication is atomic; corrupt/interrupted records are misses, never evidence. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { count } from "./perfCounters.js";

export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const contentMemo = new AsyncLocalStorage<Map<string, { stamp: string; hash: string }>>();
export function withContentMemo<T>(task: () => T): T { return contentMemo.getStore() ? task() : contentMemo.run(new Map(), task); }
/** A scope that inherits no earlier scope's observations: a guard recomputes inside it from
 * the files now (reusing only ctime-settled digests, which are content-equivalent). */
export function withFreshContentMemo<T>(task: () => T): T { return contentMemo.run(new Map(), task); }
const invocationValues = new WeakMap<object, Map<string, unknown>>();
/** A pure result computed once per content-memo scope (one invocation). The key
 * must carry everything the result depends on, including the text it read.
 * Outside a scope, and after a throw, it is simply computed again. */
export function invocationMemo<T>(key: string, compute: () => T): T {
  const store = contentMemo.getStore();
  if (!store) return compute();
  let values = invocationValues.get(store);
  if (!values) invocationValues.set(store, values = new Map());
  if (values.has(key)) return values.get(key) as T;
  const value = compute(); values.set(key, value); return value;
}
const stampOf = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const fileStamp = (path: string): string => stampOf(statSync(path, { bigint: true }));
const hashed = (bytes: Buffer): string => { count("digest.files"); count("digest.bytes", bytes.length); return digest(bytes); };
/* Stat data short-circuits re-hashing only behind a ctime guard (the racy-index
 * rule): a digest outlives its scope only for a file whose status had not
 * changed for SETTLED_NS before it was read. Any later write, even inside one
 * coarse timestamp tick, then carries a newer ctime and is hashed again. Within
 * a scope, the scope's own observations are reused as before. */
const SETTLED_NS = 2_000_000_000n;
const settled = new Map<string, { stamp: string; hash: string }>();
export function fileDigest(path: string): string {
  if (!existsSync(path)) return "absent";
  const stat = statSync(path, { bigint: true }), stamp = stampOf(stat);
  const memo = contentMemo.getStore(), prior = memo?.get(path) ?? settled.get(path);
  if (prior?.stamp === stamp) { count("digest.reuse"); return prior.hash; }
  const readAt = BigInt(Date.now()) * 1_000_000n;
  const hash = hashed(readFileSync(path));
  memo?.set(path, { stamp, hash });
  if (stat.ctimeNs < readAt - SETTLED_NS) settled.set(path, { stamp, hash });
  return hash;
}
/** A file's text. Within a content-memo scope it is read again only when the
 * file's stamp changes, the rule fileDigest uses; outside one, always read. */
export function readStampedText(path: string): string {
  const store = contentMemo.getStore();
  if (!store) return readFileSync(path, "utf8");
  let values = invocationValues.get(store);
  if (!values) invocationValues.set(store, values = new Map());
  const stamp = fileStamp(path), key = `text\0${path}`, prior = values.get(key) as { stamp: string; text: string } | undefined;
  if (prior?.stamp === stamp) return prior.text;
  const text = readFileSync(path, "utf8"); values.set(key, { stamp, text }); return text;
}
export function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => e.isDirectory() ? filesUnder(join(path, e.name)) : [join(path, e.name)]);
}
export function snapshot(root: string, paths: string[], filter: (path: string) => boolean = () => true): Record<string, string> {
  const result: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort()) {
    const absolute = isAbsolute(path) ? path : join(root, path);
    const key = relative(root, absolute);
    if (!existsSync(absolute)) { result[key] = "absent"; continue; }
    if (!statSync(absolute).isDirectory()) { result[key] = fileDigest(absolute); continue; }
    const files = filesUnder(absolute).filter(filter);
    result[`${key}/#membership`] = digest(JSON.stringify(files.map((p) => relative(root, p))));
    for (const file of files) result[relative(root, file)] = fileDigest(file);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export const sameSnapshot = (a: Record<string, string>, b: Record<string, string>): boolean => JSON.stringify(a) === JSON.stringify(b);
export function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, content); renameSync(temp, path); } finally { rmSync(temp, { force: true }); }
  return true;
}
export interface CacheRecord<T> { schema: 1; key: string; value: T; valueHash: string }
export function readCache<T>(path: string, key: string): T | undefined {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as CacheRecord<T>;
    if (record.schema !== 1 || record.key !== key || record.valueHash !== digest(JSON.stringify(record.value))) return;
    return record.value;
  } catch { return; }
}
export function writeCache<T>(path: string, key: string, value: T): void {
  writeIfChanged(path, JSON.stringify({ schema: 1, key, value, valueHash: digest(JSON.stringify(value)) } satisfies CacheRecord<T>) + "\n");
}
export interface PhaseTiming { phase: string; durationMs: number; cache?: "hit" | "miss"; reason?: string }
export class Timings {
  readonly phases: PhaseTiming[] = [];
  private readonly start = performance.now();
  async measure<T>(phase: string, task: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await task(); } finally { this.phases.push({ phase, durationMs: performance.now() - start }); }
  }
  measureSync<T>(phase: string, task: () => T): T {
    const start = performance.now();
    try { return task(); } finally { this.phases.push({ phase, durationMs: performance.now() - start }); }
  }
  get totalMs(): number { return performance.now() - this.start; }
}
