import { withContentMemo } from "./contentCache.js";
/** Standalone/internal entry boundary. Configuration is resolved once and passed
 * into the graph before importing target operations. Never an agent interface. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliRuntimeContext, inRuntimeContext } from "./runtimeContext.js";

const [entry, ...argv] = process.argv.slice(2);
try {
  if (!entry) throw new Error("Internal entrypoint missing");
  const { context, args } = cliRuntimeContext(argv, process.cwd());
  const absolute = resolve(context.harnessRoot, entry);
  if (!absolute.startsWith(resolve(context.harnessRoot, "tools") + "/") || !absolute.endsWith(".ts")) throw new Error("Entrypoint is not installed implementation");
  process.argv = [process.execPath, absolute, ...args];
  await inRuntimeContext(context, () => withContentMemo(() => import(pathToFileURL(absolute).href)));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
