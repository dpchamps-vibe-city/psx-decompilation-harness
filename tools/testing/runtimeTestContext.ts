/** Test-only target context. Package assets are intentionally named separately
 * from synthetic fixture roots; production never gets this test convenience. */
import { test as nodeTest } from "node:test";
import { HARNESS_ROOT, createRuntimeContext, inRuntimeContext } from "../lib/runtimeContext.js";
export const ROOT = HARNESS_ROOT;
export const test: typeof nodeTest = ((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === "function") args[args.length - 1] = (...values: any[]) =>
    inRuntimeContext(createRuntimeContext(HARNESS_ROOT), () => callback(...values));
  return (nodeTest as any)(...args);
}) as typeof nodeTest;
Object.assign(test, nodeTest);
export const fixtureContext = <T>(root: string, action: () => T): T => inRuntimeContext(createRuntimeContext(root), action);
