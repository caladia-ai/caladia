# @procsim/cli

Headless CLI for Caladia.

- **`simulate`** — runs Monte Carlo against a `.cala` project file and
  writes the same JSON the in-app exporter produces.
- **`validate`** — parses a `.cala` file and reports whether it is
  schema-valid (no simulation work; ideal for pre-commit / CI gates).

## `caladia simulate`

```bash
caladia simulate path/to/plan.cala --iters 10000 --seed 42 --out result.json
```

| Flag               | Default | Notes                                                          |
| ------------------ | ------- | -------------------------------------------------------------- |
| `-i, --iters <n>`  | `1000`  | Monte Carlo iteration count.                                   |
| `-s, --seed <n>`   | `42`    | RNG seed. Same seed + same inputs produce byte-identical JSON. |
| `-o, --out <file>` | stdout  | Write JSON to a file instead of stdout.                        |

Exit codes:

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| `0`  | Success.                                                                |
| `1`  | Parse error (bad `.cala` file or unreadable path).                      |
| `2`  | Engine error (zero successful iterations — usually a degenerate graph). |

## `caladia validate`

```bash
# Human-readable summary
caladia validate path/to/plan.cala

# Machine-readable for scripting / CI
caladia validate path/to/plan.cala --json
```

| Flag     | Notes                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| `--json` | Emit a JSON report on stdout (success or failure shape) instead of human text. Exit code still encodes pass/fail. |

Human output on a valid file:

```
Valid V8 .cala file: 12 nodes, 15 edges, 3 resources, 2 calendars, 1 subsystem, 1 loop, 2 scenarios
```

`--json` output on a valid file:

```json
{
  "ok": true,
  "summary": {
    "version": 8,
    "nodes": 12,
    "edges": 15,
    "resources": 3,
    "calendars": 2,
    "subsystems": 1,
    "loops": 1,
    "scenarios": 2
  },
  "truncationWarnings": []
}
```

`--json` output on an invalid file:

```json
{
  "ok": false,
  "errors": [{ "path": "nodes.3.duration", "message": "must be a positive number" }]
}
```

Exit codes:

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| `0`  | File parses cleanly.                               |
| `1`  | Parse error (bad `.cala` file or unreadable path). |

## Output

The JSON is byte-identical to a UI-driven export at the same seed (the
`toJson` function lives in `@procsim/simulation` and is consumed by both
the CLI and the app). Top-level fields: `kind`, `version`, `exportedAt`,
`projectName`, `currency`, `iterations`, `seed`, `runId`, `runTimestamp`,
`target`, plus a `result` block containing every field of
`SimulationResult` (`endDates`, `percentiles`, `tornado`, `costCurve`, etc).

## Development

From the repo root:

```bash
pnpm --filter @procsim/cli build      # compile to dist/
pnpm --filter @procsim/cli test       # run unit tests
node packages/cli/dist/index.js simulate packages/cli/__fixtures__/linear-chain.cala
node packages/cli/dist/index.js validate packages/cli/__fixtures__/linear-chain.cala
```

A linkable `caladia` binary is registered via `bin` in `package.json`;
once published, `npx @procsim/cli simulate ...` will work the same way.
