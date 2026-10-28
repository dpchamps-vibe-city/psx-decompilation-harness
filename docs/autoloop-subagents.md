# Subagents in the existing autoloop

There is **one main autoloop**. Setting `subagents` changes its work turns from
one agent working one function into up to N single-function workers in parallel.
It does not start an autoloop per worker or replace the main loop's scheduler.

The main loop retains its existing ladder, prep/matching roles, return counts,
checkpoint handling, policy review, finalization, documentation, parking,
commits and `autoFold` behavior. These settings continue to work as configured.

## Setup

Use Pi 1.2.0 or newer (`npx pi` uses this repository's development dependency).
The repo's `.pi/settings.json` declares `pi-subagents@0.82.1`. Installed harness
consumers install that independent package in their own project:

```sh
pi install --local npm:pi-subagents@0.82.1
```

Restart Pi after installation. Add this to `.pi/autoloop.json`, keeping your
existing settings:

```json
"subagents": {
  "quantity": 3,
  "model": {
    "provider": "YOUR_PROVIDER",
    "model": "YOUR_WORKER_MODEL_ID",
    "thinking": "high"
  }
}
```

`quantity` is a positive integer. `model` uses the same schema/parser as a
ladder entry. The ladder still selects the main agent; `subagents.model`
selects the workers. The current main-loop role determines whether a work turn
asks workers to prepare or match. `subgents` is also accepted as an alias;
do not specify both spellings.

Omitting the field preserves ordinary single-agent work turns.

## Run

```text
/auto_decompilation_loop [function] [--max=N]
/auto_decompilation_loop status
/auto_decompilation_loop stop
```

Each work turn delegates the current function and up to `quantity - 1` next
eligible functions. Selection excludes already selected, reserved and parked
functions and respects the invocation's existing function limit. Fewer workers
run when fewer eligible functions remain.

Workers all use the existing project directory. Each gets a single function,
the applicable preparation/matching skill and its own candidate directory under
`build/subagents/`. They test that candidate using explicit `src`/`source`
arguments, without moving it into main source. Proposed declaration changes go
in that candidate directory's `headers.patch`. No worktrees, branches, second
project copies or `split-all` runs are created. Workers do not receive a ladder
or permission to run an autoloop, select another function, park or commit.

During that same turn, the main agent actively checks `psx_autoloop_workers`,
candidate files and measurements instead of waiting for workers to finish. It
can inspect, wait, steer, stop, reroute, **takeover**, or **integrate** a slot:

- `takeover` stops the worker and waits for terminal settlement, then hands its
  build candidate and progress to the main agent. This works on an **unfinished
  attempt**. The main agent continues that candidate under `build/` itself.
- `integrate` stops the worker if it is still running, promotes the candidate
  and runs the existing main-loop byte/build/policy finalization gate immediately.
  Other workers keep working. Only a passing gate reports `integrated`. With
  `commitOnMatch: true`, that verified match commits immediately, without waiting
  for the primary function or sibling workers. The receipt and durable completion
  record carry the actual commit ID. A Git failure stops the loop; it does not
  silently defer the match into another function's commit. Ordinary main-loop
  close-out retains documentation and folding without duplicate match commits.
- Steering goes through the exact child's native Pi message queue, not the
  package's workflow-only foreground RPC route. Receipts distinguish `queued`
  from `delivered`: delivery is acknowledged only when the guidance appears in
  that child's model context. It does not claim model compliance. Status retains
  the receipts, including a failed delivery if the child ends before consuming it.

These controls affect one batch; they do not introduce a second rolling loop.

After workers settle, the main loop promotes the current function's build
candidate and runs its ordinary policy, diff and finalization path. Promotion
first parses the candidate and checks the owning library part's exact definition
contract and original function-partition identity. A two-function draft cannot
replace a one-function part, and an old draft cannot survive a changed assignment
merely because the destination's stub text stayed the same. Declaration patches
may touch only owned header files. Rejected drafts stay under `build/`, without
changing live source or headers.

Other candidates stay under `build/` until the main loop selects their function,
then enter that same path. A verified prepared draft can finish through the loop's
existing static-finalization path. Failed explicit integration rolls back its
source and header writes; an unexpected loop exception also rolls back unsettled
worker promotions. Rollback is compare-and-swap: concurrent edits are never
overwritten, and an unsafe rollback stops the loop for review. Build candidates
remain available for revision. Successful matches and ordinarily parked attempts
retain the existing close-out behavior.

The main loop still decides when to escalate, retry, park, document, commit or
fold. In particular, `autoFold: true` works with subagents and runs the same fold
and fold-cleanup logic as before. No new clean-index requirement, controller-
only tool restriction, commit setting or fold exception is imposed.

Typing interactive input or `stop` uses the existing stop signal and cancels
outstanding workers. The harness waits for their owned terminal responses;
unconfirmed cancellation retains `active.json` rather than permitting overlapping
writers. Candidates remain under `build/subagents/`, and `controller.json` under
`runtimeDir` records their paths; unselected drafts are not mixed into main source.

The integration uses the package's public runtime-agent and owned-leaf APIs.
The explicitly loaded worker extension binds native Pi steering for that exact
owned attempt. Concurrent foreground leaves here are promises within the
package, not separate autonomous loops or detached writer processes.
