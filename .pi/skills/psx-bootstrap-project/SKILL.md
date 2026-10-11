---
name: psx-bootstrap-project
description: Bootstrap a repository after installing the PSX harness with pi install --local. Create the complete project scaffold, headers, configuration, input directories and ignore rules, then explain what the user must supply. Defaults to exe; pass library for ELF/ar library reconstruction. Obtains missing pinned public tooling sources automatically; no game/SDK asset or compiler-binary downloads or matching runs.
---

# Bootstrap a PSX repository

This skill can live in an installed package under `.pi/git/`, `.pi/npm/`, or
outside the project. **The project is the user's current working directory,
not the directory above this skill.** Do not cd to the installed package to
run project setup. Read [the onboarding contract](../../../docs/bootstrap.md)
(relative to this skill) if needed.

1. Interpret the user's argument as `exe` (default) or `library`. Reject other
   modes; do not guess a library target merely because SDK libraries exist.
2. Inspect the current repo briefly for existing configuration or conflicting
   ownership. Installation alone is not permission to delete existing files.
3. Call `psx_bootstrap_project` with that mode. It deterministically creates the
   entire project scaffold in the current repo: `include/` (not `includes/`),
   `src/`, configs, project loop settings, plugin directories, and pinned public
   tooling sources in build/dependencies/ (prepared from the installed package
   when present, downloaded automatically when missing). Download failures
   report Git/network blockers; do not ask the user to fetch repos by hand.
   It creates `extracted/`, `library-input/psyq/LIB/`, and empty `lib/` if absent,
   merges `.gitignore`, and leaves Pi's existing
   `.pi/settings.json` package declaration untouched.
4. If preflight reports a collision, stop and explain it. Do not use `rm -rf`,
   clear `lib/`, overwrite headers/configuration, add force flags, or erase
   another project's npm tasks to get past it. Cancellation/IO errors can
   leave an additive partial scaffold; a re-run safely fills missing files.
5. Summarize exactly what was created/preserved and give the supply checklist
   from the tool. The answer must name these destinations:
   - **EXE:** legally obtained extracted disc/game files, including its PS-X EXE,
     under `extracted/`; identify them before creating a measured splat config.
   - **Library:** original supported ELF/ar targets under `library-input/`;
     `project.json` initially selects `.a` archives only. Adjust selection for
     standalone objects, and keep every configured glob meaningful.
   - **SDK (when needed):** original PSY-Q/other SDK libraries under
     `library-input/psyq/LIB/`, matching release headers under `library-input/psyq/INCLUDE/`.
     For another layout, configure the paths explicitly.
   - **Conversion:** `lib/` is for converted ELF objects/archives. PSY-Q LIB/LNK
     needs a separately supplied converter and retained provenance; converted
     object identity is not proof of original LNK encoding identity. EXE SDK
     integration performs supported first-time conversion of non-colliding members.
   - **Tools:** installed package dependencies, provisioned cc1/cross-binutils/Python
     tools and vendor prerequisites. Bootstrap does not download binaries or
     proprietary inputs. Public tooling sources are provisioned automatically;
     Git/network access is required only when those sources are missing.
6. Prepare supported tooling with `psx_prepare_tooling` from the
   target repository to verify/prepare m2c. If a command
   fails, report the actual blocker and leave the additive scaffold intact; do
   not claim ready tooling. Do not build/download a compiler automatically or
   run target-dependent commands before inputs exist.
7. Ask the user to `/reload` Pi, then invoke `/skill:psx-identify-project` once
   inputs are supplied. If AGENTS.md/configuration was preserved, flag it for
   review against [the onboarding contract](../../../docs/bootstrap.md) rather than silently replacing it.

Stop after scaffolding and the handoff. Do not start splitting, matching,
autoloop, commits, asset fetching or claim a configured/verified target.
Supported defaults are compiler/SDK candidates, not observed target facts.
