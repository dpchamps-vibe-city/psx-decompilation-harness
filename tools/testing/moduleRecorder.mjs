// Records, for one process, every module the loader loads and every file read
// through node:fs, as JSON lines in $MODULE_RECORDER_OUT. Observation only; used
// by the verification-closure completeness test.
import fs from "node:fs";
import { register, syncBuiltinESMExports } from "node:module";

const out = process.env.MODULE_RECORDER_OUT;
if (out) {
  const append = fs.appendFileSync.bind(fs);
  register(`data:text/javascript,${encodeURIComponent(`
    import { appendFileSync } from "node:fs";
    export async function load(url, context, next) {
      if (url.startsWith("file:")) appendFileSync(${JSON.stringify(out)}, JSON.stringify({ module: url }) + "\\n");
      return next(url, context);
    }`)}`);
  for (const name of ["readFileSync", "openSync", "createReadStream"]) {
    const original = fs[name];
    fs[name] = function (path, ...rest) {
      if (typeof path === "string" || path instanceof URL) append(out, JSON.stringify({ read: String(path) }) + "\n");
      return original.call(this, path, ...rest);
    };
  }
  syncBuiltinESMExports();
}
