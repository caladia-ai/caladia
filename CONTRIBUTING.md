# Contributing to Caladia

Issues and PRs welcome. For substantial changes, open an issue first so we can discuss the approach before you invest time.

## Dev setup

Caladia is a pnpm workspace. Requires Node ≥ 22 and pnpm ≥ 9.

```bash
pnpm install        # install workspace dependencies
pnpm dev            # engines watch + Vite dev server, in parallel
```

Open `http://localhost:5173`.

## Common commands

```bash
pnpm -r build       # build all packages
pnpm test           # run all tests (with the canonical TZ pin — see ARCHITECTURE.md → Engine local-time anchoring)
pnpm -r typecheck   # strict TypeScript check across all packages

# Simulation performance benchmark
pnpm --filter @procsim/simulation bench
```

## Supported browsers

Caladia targets modern evergreen browsers. The app uses Web Workers, IndexedDB, `crypto.randomUUID`, and `structuredClone` directly; if any are missing at boot, the app refuses to start and shows an "upgrade your browser" page instead of rendering into a broken environment.

| Browser | Minimum version | Released   |
| ------- | --------------- | ---------- |
| Chrome  | 100             | March 2022 |
| Firefox | 100             | May 2022   |
| Safari  | 15.4            | March 2022 |
| Edge    | 100             | April 2022 |

These minimums are declared in three places — keep them in sync if you change one:

- `packages/app/package.json` → `browserslist` (build-tool input)
- `packages/app/vite.config.ts` → `build.target` (esbuild transpile target)
- `packages/app/index.html` → boot feature-detect (runtime guard + user-facing message)

## Where to read next

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — package dependency graph, public API per package, load-bearing patterns, decision log. Read this before touching engine code.
- **Package layout** — eight packages in strict dependency order: `file-format → calendar → scheduler → simulation → engine-worker / cli → app ← importers`. Core engines (`file-format`, `calendar`, `scheduler`, `simulation`) are pure and framework-free; only `app` imports React.

## Deployment

The hosted instance at `app.caladia.ai` is built and served by Cloudflare Pages. Build settings live in [`wrangler.toml`](wrangler.toml) at the repo root — `pnpm install --frozen-lockfile && pnpm -r build`, output to `packages/app/dist`. Cloudflare auto-builds on every push to `main`; preview builds fire on every branch. No deploy step in GitHub Actions.

## PR conventions

- One coherent change per PR. Big features land as a sequence of small PRs, not one giant one.
- TypeScript strict (`no any`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); prefer `unknown` + narrowing.
- Errors in core engines are `Result<T, E>` unions, not throws. Throws are reserved for invariant violations (programmer error).
- Tests live next to code (`foo.ts` / `foo.test.ts`). `pnpm test` must pass on every commit.
- Commit messages explain _why_, not _what_. The diff already shows what changed.
