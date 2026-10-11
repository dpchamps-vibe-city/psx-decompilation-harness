import { projectRoot } from "../lib/runtimeContext.js";
import { resourceCli } from "./resource-extraction/cli.ts";
import { recoverAbandonedResourceLocks } from "../lib/resourceLocks.ts";
recoverAbandonedResourceLocks(projectRoot());
await resourceCli("analyze", process.argv.slice(2));
