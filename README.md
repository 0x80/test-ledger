# @0x80/test-ledger

Telemetry for local test runs: per-file and per-test records, host load and queue wait while a run
was in progress, and the Turbo task summary. The package folds this into a local SQLite database and
queries it through five canned reports (`flaky`, `slow`, `contention`, `shape`, `runs`).

## Why

When CI stops running your test suite on every push — because it moved to a scheduled cadence, or
off the merge path entirely — the local run becomes the load-bearing gate, and it's usually the
one you know least about. "Is this test actually flaky, or did it just fail because six other
processes were competing for the same cores?" is normally answered by re-running and forming an
opinion. This package answers it with a query instead: every local run's per-test outcomes and the
host load while they happened land in the same database, so a flaky-looking test can be checked
against whether the host was calm or crushed at the moment it failed.

It is deliberately not a dashboard or a CI product. Canned CLI reports plus ad-hoc SQL against a
local file are the whole analysis surface, and there is no per-test retry, quarantine, or
auto-skip behavior anywhere in it — recording flakiness must not become acting on it silently.

## Install

```bash
pnpm add -D 0x80/test-ledger
```

Installs straight from GitHub. `dist/` is committed to the repo (see
[§ Why `dist/` is tracked](#why-dist-is-tracked)), so the install needs nothing beyond git access —
no registry, no token, no global pnpm config.

### Exports

- **`.`** — the run-envelope helpers a test-runner wrapper uses to open and close a run
  (`writeRunStart`, `writeRunEnd`, `appendEvents`), the load sampler (`startSampler`), the Turbo
  summary parser (`parseTurboSummary`), the run-id minter (`mintRunId`), the failure classifier
  (`classifyFailure`), the event types (`LedgerEvent`, `Lane`, `FailureClass`, …), the store
  (`openLedger`, `ingest`, `ingestAll`, `ingestRun`, `withLedgerWriterLock`), and every report (`flakyReport`, `slowReport`,
  `contentionReport`, `shapeReport`, `runsReport`).
- **`./reporter`** — `TestLedgerReporter`, the Vitest custom reporter. Kept as its own subpath so a
  Vitest config can resolve it as a reporter module path without pulling the rest of the package's
  Node-only surface (SQLite, `node:fs`) into a lane that shouldn't need it.

## Wiring it in

**The reporter, in a Vitest config:**

```ts
import { fileURLToPath } from 'node:url'

export default {
  test: {
    reporters: [
      'default',
      [
        fileURLToPath(import.meta.resolve('@0x80/test-ledger/reporter')),
        { lane: 'unit', packageName: 'my-package' },
      ],
    ],
  },
}
```

Resolve the reporter to an **absolute path** rather than passing the bare specifier
(`'@0x80/test-ledger/reporter'`) directly in the `reporters` array. Vitest resolves a bare reporter
specifier from the consuming package's own `node_modules`, so a shared config factory that passes
it straight through breaks at Vitest startup for every package that doesn't depend on this package
directly — a failure static analysis of the config object can't see, because it only happens in
the consumer's resolution scope. Resolving it once, in the factory, with `import.meta.resolve`,
makes it load correctly from anywhere.

`lane` and `packageName` are free-form strings recorded on every file/test event — they're what the
`shape` report groups by, not a fixed enum the package validates.

**The run envelope, in a test-runner wrapper** (the process that spawns the actual Vitest/Turbo
invocation and is alive for the whole run):

```ts
import { mintRunId, startSampler, writeRunEnd, writeRunStart } from '@0x80/test-ledger'

const runId = process.env.TEST_LEDGER_RUN_ID ?? mintRunId()
writeRunStart(runId, {
  invocation: process.argv.join(' '),
  repo: 'my-repo',
  branch: currentBranch(),
  worktree: process.cwd(),
  gitSha: currentSha(),
  dirty: isDirty(),
  concurrency: resolvedConcurrency,
  liveSlots: countLiveSlots(),
  queuedMs: waitedMs,
  queueTimedOut: waitTimedOut,
  turboForce: usedForce,
})

const stopSampler = startSampler(runId, { liveSlots: countLiveSlots })

// … spawn the child process, forwarding TEST_LEDGER_RUN_ID and TEST_LEDGER_DIR so the
// reporter and this wrapper agree on where events land …

stopSampler()
writeRunEnd(runId, exitCode)
```

`writeRunStart` / `writeRunEnd` / `appendEvents` are synchronous and swallow every failure — safe
to call from a synchronous wrapper, including at process-exit, where nothing awaits them and an
unawaited async write could be lost entirely.

## CLI

Every command reads the local database (`~/.local/share/test-ledger/ledger.db` by default; see
[§ Where data lives](#where-data-lives)) via the `test-ledger` bin.

| Command      | Does                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `ingest`     | Folds every un-ingested run directory's NDJSON into the database           |
| `flaky`      | Tests ranked by failure rate, with denominators and a failure-class split  |
| `slow`       | Files ranked by their share of total summed duration                       |
| `contention` | Runs ranked by host load, with their queue wait and timeout status         |
| `shape`      | Where time goes, broken out by package and lane, plus Turbo cache-hit rate |
| `runs`       | Recent run history                                                         |
| `prune`      | Deletes runs and their NDJSON older than `--days` (default 90)             |

`--limit` (default 25), `--min-runs` (flaky only, default 3), and `--days` (prune only, default 90)
narrow or widen a report; `test-ledger <command>` with no flags uses those defaults.

## Where data lives

Everything lands under `~/.local/share/test-ledger` by default — machine-global on purpose, since
that's what makes cross-run and cross-worktree contention analysis possible at all, and what lets
the data outlive the worktree that produced it:

- `runs/<runId>/<pid>.ndjson` — the raw per-process append log, one file per test-runner process.
- `ledger.db` — the SQLite database that `ingest` folds NDJSON into, and that every report queries.

Two environment variables control this:

- **`TEST_LEDGER_DIR`** — overrides the base directory (default `~/.local/share/test-ledger`). Set
  it per-invocation to point a run's data somewhere else, e.g. a temp directory in tests.
- **`TEST_LEDGER_DISABLED`** — set to `1` to disable the reporter entirely for an invocation. Checked
  first thing in the reporter's constructor, before any filesystem access: a disabled run writes
  nothing, mints no run id, and leaves no trace to clean up.

## Design invariants

These are load-bearing, not stylistic — breaking one reopens the specific failure it exists to
prevent:

- **The test path only appends.** The reporter's only work inside a running test suite is one
  `appendFile` per test file to a pid-scoped NDJSON file: no database driver, no network call, no
  lock, no fsync. Concurrent test-runner processes never coordinate with each other or with
  anything else. Folding NDJSON into SQLite (`ingest`) is a separate step that never runs inside
  the measured path.
- **The reporter never throws.** Every write is wrapped; on its first failure (a read-only
  directory, a full disk) the reporter latches itself disabled for the rest of the run rather than
  retrying. A telemetry package that can fail the test run it's instrumenting is worse than no
  telemetry at all.
- **Ingest is idempotent, by two mechanisms that cover different cases.** The `ingested_runs` marker
  is what makes a _completed_ run a no-op on a later re-ingest. The fact that a run's whole fold —
  every table plus that marker — commits as one transaction is what makes an _interrupted_ run safe,
  by leaving nothing behind for the retry to duplicate. Both matter because `run_samples` and
  `turbo_tasks` are append-only with no per-row key, so unlike the other four tables they have no
  convergence of their own and would simply append a second copy.
- **Ledger writers are serialized by a lock.** `test-ledger ingest` and `test-ledger prune` hold
  `ledger-writer.lock` in the ledger directory before opening the database file. The driver locks
  that file exclusively at open, so the shared lock makes a concurrent writer wait instead of die.
  A lock is reclaimed only once it is both older than ten minutes _and_ its recorded holder is no
  longer running, so a genuine hours-long backlog ingest is never reclaimed out from under itself.
- **Ingest collapses the WAL when it finishes.** Without that the write-ahead log only grows; a
  999-run backlog folded through the old row-at-a-time path left a 41 GB WAL beside a 1.4 GB
  database. The same backlog through the batched path is about 1.6 GB total.
- **NDJSON is the durable raw form.** The SQLite database is a derived view, always rebuildable
  from the retained NDJSON. Nothing about this package's design should ever make the NDJSON files
  disposable ahead of the database that was built from them — a future re-ingest into a different
  storage engine depends on that being true.

## Known limitations

Honestly, not aspirationally:

- **No sync.** Everything here is local-only, through `@tursodatabase/database`. Pushing this data
  to a shared/remote database (`@tursodatabase/sync`, credentials, `push()`) is designed but not
  built — a synced database carries change-tracking state a local-only file doesn't, so that phase
  is planned as a fresh synced database re-ingested from retained NDJSON, not an in-place upgrade
  of the local file.

## Why `dist/` is tracked

The package is installed straight from a git ref (`pnpm add -D 0x80/test-ledger`), not from a
registry. pnpm refuses to run _any_ lifecycle script (`preinstall`/`install`/`postinstall`/
`prepare`) for a git-hosted dependency unless it's explicitly allowlisted in the installing
machine's own pnpm config (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), and that check is
presence-based, not content-based — even a no-op `prepare` script trips it. Building on install was
therefore not an option without asking every installer to edit their global pnpm config first.
Instead, the `tsdown` build output under `dist/` is committed, and `package.json` carries no
install-time lifecycle script at all, so `pnpm add -D` needs nothing beyond fetching the git ref.

**Do not gitignore `dist/`.** Doing so would make every fresh install of this package broken until
someone builds and pushes by hand. The pre-commit hook (`dist-freshness` in `lefthook.yml`) guards
against `dist/` drifting from `src/`: on any staged `.ts` change it rebuilds and formats, then
fails the commit if `dist/` comes out dirty. That hook only runs once `lefthook install` has been
run in this checkout — a fresh clone needs `pnpm exec lefthook install` before the guard is active.

## Development

```bash
pnpm install
pnpm exec lefthook install   # once, so the dist-freshness pre-commit hook is active
pnpm build
pnpm test
pnpm typecheck
```

## License

MIT
