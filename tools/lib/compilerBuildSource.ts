/** Source export and identity shared by explicit project provisioning and
 * ordinary supported compiler builds. No configuration or compiler changes. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { digest, fileDigest, filesUnder } from "./contentCache.js";

export function sourceExportRecipe(recipe: string, version: string): string {
  if (!/^[\d.]+$/.test(version) || !recipe.includes(`ENV VERSION=${version}\n`))
    throw new Error("Recipe VERSION does not identify the configured GCC version");
  const end = recipe.indexOf("FROM scratch AS export");
  if (end < 0 || recipe.indexOf("FROM scratch AS export", end + 1) >= 0)
    throw new Error("Expected one explicit old-gcc scratch export stage");
  return recipe.slice(0, end) + `
# Preserve the inputs and generated C/headers from this exact compiler build.
RUN set -eu; root=/work/gcc-\${VERSION}; dest=/build/compiler-source; \\
    mkdir -p "$dest/src"; \\
    if [ -d "$root/gcc" ]; then base="$root/gcc"; else base="$root"; fi; \\
    mkdir -p "$dest/src/gcc"; \\
    find "$base" -maxdepth 1 -type f \\( -name '*.c' -o -name '*.h' -o -name '*.md' -o -name '*.def' -o -name '*.y' -o -name '*.in' -o -name '*.sh' -o -name '*.texi' -o -name 'Makefile*' -o -name 'configure*' -o -name 'config.*' -o -name 'COPYING*' -o -name 'ChangeLog*' -o -name 'README*' -o -name 'INSTALL*' \\) -exec cp -p {} "$dest/src/gcc/" \\;; \\
    mkdir -p "$dest/src/gcc/config"; \\
    find "$base/config" -maxdepth 1 -type f -exec cp -p {} "$dest/src/gcc/config/" \\;; \\
    for arch in mips i386; do if [ -d "$base/config/$arch" ]; then cp -a "$base/config/$arch" "$dest/src/gcc/config/"; fi; done; \\
    for part in include libiberty; do \\
      if [ -d "$root/$part" ]; then \\
        mkdir -p "$dest/src/$part"; \\
        find "$root/$part" -maxdepth 1 -type f \\( -name '*.c' -o -name '*.h' -o -name '*.in' -o -name '*.def' -o -name 'COPYING*' -o -name 'README*' \\) -exec cp -p {} "$dest/src/$part/" \\;; \\
      fi; \\
    done; \\
    sha256sum /work/gcc-\${VERSION}.tar.gz > "$dest/upstream.sha256"
FROM scratch AS export
COPY --from=build /build/ .
`;
}

export function writeCompilerSourcePin(options: { bundle: string; compiler: string; binaryReference?: string; recipe: string; version: string; root: string; captureRecipe: string }): void {
  const { bundle, compiler, recipe, version, root, captureRecipe } = options;
  const source = join(bundle, "src");
  const files = filesUnder(source).map(file => relative(source, file).split("\\").join("/")).sort();
  if (!files.includes("gcc/toplev.c") || !files.includes("gcc/config/mips/mips.c"))
    throw new Error("Compiler source export is missing cc1/MIPS source");
  const hash = digest(files.map(file => `${fileDigest(join(source, file))}  ${file}\n`).join(""));
  const archiveHash = readFileSync(join(bundle, "upstream.sha256"), "utf8").split(/\s+/)[0];
  const text = readFileSync(recipe, "utf8"), gnuPath = /ENV GNUPATH=([^\s]+)/.exec(text)?.[1];
  if (!gnuPath || !/^[a-f0-9]{64}$/.test(archiveHash ?? "")) throw new Error("Missing measured upstream archive identity");
  const contextFiles = [recipe, ...filesUnder(join(dirname(recipe), "patches")), ...filesUnder(join(dirname(recipe), "tests"))];
  const contextHash = digest(JSON.stringify(contextFiles.map(file => [relative(dirname(recipe), file), fileDigest(file)]).sort()));
  const recipeDir = join(bundle, "recipe"); mkdirSync(recipeDir, { recursive: true });
  cpSync(recipe, join(recipeDir, "Dockerfile"));
  for (const dir of ["patches", "tests"]) if (existsSync(join(dirname(recipe), dir)))
    cpSync(join(dirname(recipe), dir), join(recipeDir, dir), { recursive: true, preserveTimestamps: true });
  const compilerHash = fileDigest(compiler);
  const pin = {
    name: `gcc-${version}-psx`, gccVersion: version,
    correspondsTo: { binary: relative(root, options.binaryReference ?? compiler), binarySha256: compilerHash, recipe: "recipe/Dockerfile", target: "mips-sony-psx" },
    upstream: { url: `https://ftp.gnu.org/${gnuPath}/gcc/gcc-${version}.tar.gz`, sha256: archiveHash },
    build: { recipeSha256: fileDigest(recipe), contextSha256: contextHash, sourceCaptureRecipeSha256: digest(captureRecipe), rebuiltBinarySha256: compilerHash },
    tree: { root: "src", sha256: hash, algorithm: "sha256 over LC_ALL=C-sorted lines of '<file sha256>  <path relative to src>\\n'", files: files.length },
    included: ["gcc top-level C, headers, machine/build inputs, including generated headers", "MIPS target and i386 build-host configuration", "shared include/libiberty C and headers when present"],
    excluded: ["compiled binaries and object archives", "other language front ends and unrelated targets", "runtime libraries, testsuites and generated documentation"],
    exclusionRisk: "Source queries cover the captured cc1/host/MIPS inputs, not other compiler programs. Source availability does not establish RTL/oracle adapter support.",
  };
  writeFileSync(join(bundle, "pin.json"), JSON.stringify(pin, null, 2) + "\n");
}
