/** Period cccp treats CRLF continuations differently. Reference inputs remain
 * immutable; production reads an LF-only, content-addressed header tree. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { digest, filesUnder, invocationMemo, snapshot, writeIfChanged } from "./contentCache.js";
import { count } from "./perfCounters.js";
/* Every cpp/as flag lookup asks for this; one invocation observes the reference
 * tree once. The copy is content-addressed, so the path stays a complete copy of
 * what was observed, and acceptance guards (the member batch guard, the
 * finalization workspace identity) re-snapshot headers.reference themselves. */
export function referenceHeaderCopy(directory: string, root: string): string {
  return invocationMemo(`reference-headers\0${root}\0${directory}`, () => publishReferenceHeaderCopy(directory, root));
}
function publishReferenceHeaderCopy(directory: string, root: string): string {
  count("referenceHeaders.snapshot");
  const files = filesUnder(directory);
  const key = digest(JSON.stringify(snapshot(root, files)));
  const output = join(root, "build/headers/reference", key);
  if (!existsSync(join(output, ".complete"))) {
    for (const file of files) {
      const path = join(output, relative(directory, file)); mkdirSync(dirname(path), { recursive: true });
      writeIfChanged(path, readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    }
    mkdirSync(output, { recursive: true }); writeFileSync(join(output, ".complete"), key);
  }
  return output;
}
