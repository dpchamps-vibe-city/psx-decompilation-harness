/**
 * getPrompt.ts — Retired standalone prompt builder
 *
 * The active Pi commands and autonomous workers dispatch `.pi/skills/`
 * directly and do not call this module. The archived templates under
 * `prompts/legacy/` were removed on 2026-10-10; this CLI is retained only
 * to direct anyone who reaches for it to the active skill workflow.
 *
 * Usage:
 *   npx tsx tools/agent/getPrompt.ts [func_name | --refine | --project]
 */

if (process.argv[1]?.includes("getPrompt")) {
  process.stderr.write(
    "getPrompt.ts: retired.\n\n" +
    "The archived templates under prompts/legacy/ were removed on 2026-10-10.\n" +
    "Active Pi workflows dispatch `.pi/skills/psx-decompile-function/SKILL.md`\n" +
    "or `.pi/skills/psx-refine-function/SKILL.md` directly.\n\n" +
    "For manual prompt reproduction, load the relevant skill file or run:\n" +
    "  npx tsx tools/agent/reference.ts <topic>\n",
  );
  process.exit(1);
}