# Phase 48 — Simulation performance baseline

Captured 2026-05-23. The "Slice 1 baseline" column reports pre-Phase-48
numbers; subsequent columns track each shipped optimization slice.

Reproduce with `pnpm --filter @procsim/simulation bench` from the repo root
(append `-- --early-stop` for the convergence-aware mode).
See [bench/run-sim.ts](./run-sim.ts) for methodology details.

## Machine

|                                    |                           |
| ---------------------------------- | ------------------------- |
| Hardware                           | Apple M3 Ultra, 28 cores  |
| OS                                 | macOS 26.3 (build 25D125) |
| Node                               | 25.9.0                    |
| V8                                 | 14.1.146.11-node.25       |
| Seed                               | `0xC0FFEE`                |
| Warmup runs                        | 1                         |
| Measured runs (median of)          | 3                         |
| `schedule()` reps for differential | 25                        |

## Results — `simulate()` wall-clock, median of 3

| Template                    |     Iters | Slice 1 baseline | Slice 3 (current) |      + `earlyStop` |            Speedup vs baseline |
| --------------------------- | --------: | ---------------: | ----------------: | -----------------: | -----------------------------: |
| `simple-sequential`         |     1 000 |            50 ms |             55 ms |   41 ms (conv@500) |                            ~1× |
| `simple-sequential`         |    10 000 |           440 ms |            264 ms |   30 ms (conv@350) |                up to **14.7×** |
| `oncology-drug-development` |       100 |           5.09 s |            498 ms |             509 ms |                        **10×** |
| `oncology-drug-development` | **1 000** |      **48.48 s** |        **4.52 s** |         **4.51 s** | **10.7×** ← under 5–7 s target |
| `oncology-drug-development` |    10 000 |         483.48 s |           44.55 s | 9.35 s (conv@2050) |                  up to **52×** |
| `tentpole-feature-film`     |       100 |           1.74 s |            375 ms |             373 ms |                       **4.6×** |
| `tentpole-feature-film`     |     1 000 |          17.32 s |            3.02 s |             2.99 s |                       **5.7×** |
| `tentpole-feature-film`     |    10 000 |         172.90 s |           28.99 s | 4.80 s (conv@1600) |                  up to **36×** |

**Phase 48 target hit by Slice 3 alone.** Oncology @ 1 000 = **4.52 s** on
M3 Ultra, under the 5–7 s budget agreed at phase open. With Slice 4
(parallel workers) still to land, the target is comfortable.

### Reading the table

- `simulate() median`: full Monte Carlo wall-clock (median of 3 measured runs,
  one warmup discarded).
- `schedule() per call`: a single `schedule(input)` call against the static
  template input, median of 25 reps. Extrapolated to `N × schedule()`.
- Wrapping overhead = `simulate() − N × schedule()`. Negative values
  for Oncology mean the simulate-time CPM is _faster_ than the static-input
  CPM. Most plausible reason: per-iteration Bernoulli collapse forces every
  decision node's `passProbability` to exactly 0 or 1, which short-circuits
  paths in [`packages/scheduler/src/cpm.ts`](../../scheduler/src/cpm.ts) that
  the fractional static input has to walk in full.

### Where the time goes (V8 sampling profile)

Captured via:

```
pnpm --filter @procsim/simulation bench -- \
  --only oncology-drug-development:1000 \
  --profile /tmp/oncology-1k.cpuprofile
```

Self-time top 10 (one Oncology @ 1k run = 51 s wall, ~202k samples at 256 µs
intervals; multiple rows per function reflect distinct call-sites that V8
treats as separate nodes — the calendar functions are inlined into several
scheduler hot paths):

| Self ms | Self % | Function                                                                     |
| ------: | -----: | ---------------------------------------------------------------------------- |
|   6 508 |  12.6% | `isDayWorking` ([packages/calendar/src](../../calendar/src))                 |
|   6 150 |  11.9% | `schedule` ([packages/scheduler/src/cpm.ts:190](../../scheduler/src/cpm.ts)) |
|   6 051 |  11.7% | `workingHoursBetween` (calendar)                                             |
|   2 230 |   4.3% | `isDayWorking` (inlined call-site)                                           |
|   2 047 |   4.0% | `isDayWorking` (inlined call-site)                                           |
|   1 937 |   3.8% | `startOfNextDay` (calendar)                                                  |
|   1 931 |   3.7% | `addWorkingHours` (calendar)                                                 |
|   1 599 |   3.1% | `resolveHolidaySet` (calendar)                                               |
|   1 429 |   2.8% | `prevWorkingDayEnd` (calendar)                                               |
|   1 252 |   2.4% | `intersectCalendars` (calendar)                                              |

Rolled up by function (total time including descendants):

| Total ms | Total % | Function                                                                |
| -------: | ------: | ----------------------------------------------------------------------- |
|   50 553 |   97.9% | `simulate()` (entry)                                                    |
|   50 407 |   97.7% | `schedule()` (per-iteration)                                            |
|   15 252 |   29.5% | `workingHoursBetween`                                                   |
|   11 736 |   22.7% | `addWorkingHours`                                                       |
|    6 912 |   13.4% | `isDayWorking`                                                          |
|    4 974 |    9.6% | `validate` ([cpm.ts:9](../../scheduler/src/cpm.ts))                     |
|    4 513 |    8.7% | `prevWorkingDayEnd`                                                     |
|    3 922 |    7.6% | `buildLoopResourceEntries` ([loop.ts:239](../../scheduler/src/loop.ts)) |
|    3 050 |    5.9% | `computeCosts` ([cost.ts:31](../../scheduler/src/cost.ts))              |
|    3 009 |    5.8% | `costForNode`                                                           |
|    2 990 |    5.8% | `resolveAssignmentCalendar`                                             |

## Ranked attack list (input to Slices 2–4)

**(1) Cache calendar resolution + invariant validation across iterations** —
the headline win. The combined calendar functions (`isDayWorking`,
`workingHoursBetween`, `addWorkingHours`, `prevWorkingDayEnd`,
`startOfNextDay`, `intersectCalendars`, `resolveHolidaySet`,
`resolveAssignmentCalendar`) consume **~55–60%** of total CPU time. Most of
their inputs (calendar definitions, holiday presets, assignment-to-calendar
resolution) are invariant across iterations. Computing once before the MC
loop and reusing — likely as a flat working-hours offset table per
calendar, plus a cached effective-calendar lookup per node — should be a
multiple-× win on the giants. `validate()`'s 9.6% is the same shape: same
input every iteration, validated identically; lift it out of the per-iter
loop.

This is **Slice 3** in the phase plan and now clearly the highest-leverage
slice. The `schedule()` API split into `prepareSchedule(input)` +
`scheduleFromPrepared(prepared, sampledNodes)` falls out naturally — the
prepared object is exactly the calendar + topo + validation cache.

**(2) Convergence early-stop covering all diagnostics (Slice 2).**
Multiplies whatever Slice 3 saves by reducing N. Detector machinery already
exists in [packages/simulation/src/index.ts](../src/index.ts) but only
annotates `convergence.atIteration` rather than short-circuiting. Per the
phase-open conversation, the early-stop bar must cover criticality,
tornado, path frequency, cost percentiles — not just end-date percentiles
— otherwise tail diagnostics degrade silently.

**(3) Parallel workers (Slice 4).** Near-linear speedup on multi-core
machines. With Slice 3 in place, the prepared-graph payload structured-
clones once into each worker; each worker then runs its iteration shard
against the same prepared cache. Aggregation math is clean (sums, bounded
heaps merge as top-K of unions, `endDates` concat + re-sort).

**Deferred / not pursuing in Phase 48:** loop unrolling rewrite (7.6% — not
big enough to displace Slice 3); cost-pass elision when the caller doesn't
need cost diagnostics (5.9% — worth revisiting if everything above lands
and we still want more); per-iteration allocation reduction in
`sampledNodes` map construction (small, doesn't show up in the profile).

## Phase 48 Slice 4b — `--parallel N` flag

`--parallel N` measures the engine's parallel path
(`runShard ×N` + `assembleFromShards`) by running shards SEQUENTIALLY
in-process. Node has no Web Workers, so this captures merge overhead +
correctness only — actual wall-clock speedup must come from in-browser
runs against the same templates.

Example smoke run:

```bash
pnpm --filter @procsim/simulation bench -- \
  --only oncology-drug-development:100 --parallel 4
```

Adds two columns: `parallel(N) in-proc` (total time for N sequential
shards + merge) and `vs simulate()` (signed percent vs the single-thread
median). A small positive overhead (≤ ~25% on giants) reflects per-shard
`prepareSchedule` duplication; a large positive number signals an
`assembleFromShards` merge regression and should be investigated.

**In-browser parallel speedup numbers** for the SimulateView path are
not pinned here — they vary with device core count. The worker-count
formula lives in [packages/app/src/lib/simulateParallel.ts](../../app/src/lib/simulateParallel.ts).
Spot-check by running on a real machine via the app and watching the
"last run" duration in the verdict tile.

## Operational notes

- **Why no `node --cpu-prof`?** The harness uses `tsx`, which executes the
  script in a worker thread; `--cpu-prof` only captures the main thread. The
  bench instead drives the V8 sampling profiler programmatically via
  `node:inspector` (`--profile <path>` flag), capturing only the steady-state
  measured run after warmup. This sidesteps tsx entirely.
- **Why the negative wrapping overhead on Oncology?** See the note under the
  table — the per-iter Bernoulli collapse makes the per-iteration CPM strictly
  cheaper than the static-input CPM, so `simulate(N)` finishes faster than
  `N × schedule(staticInput)`. The differential is still a useful upper bound
  for "non-CPM overhead" on Tentpole (≈ 8% there) and small templates
  (≈ 27% on simple-sequential @ 10k — fixed cost, gets diluted at scale).
- **Profiles are not committed.** They're large (~5 MB) and re-generatable.
  Regenerate per the command in the section above.
