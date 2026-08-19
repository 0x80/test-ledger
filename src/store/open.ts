import { mkdirSync } from 'node:fs'

import { connect } from '@tursodatabase/database'

import { databasePath, ledgerDir } from '../paths.ts'
import { SCHEMA } from './schema.ts'

export type Ledger = Awaited<ReturnType<typeof connect>>

const RUN_COLUMN_UPGRADES = [
  { name: 'queued_ms', statement: 'ALTER TABLE runs ADD COLUMN queued_ms INTEGER' },
  { name: 'queue_timed_out', statement: 'ALTER TABLE runs ADD COLUMN queue_timed_out INTEGER' },
] as const

/** Adds columns introduced after an existing ledger file's `runs` table was first created. */
async function applyRunColumnUpgrades(database: Ledger): Promise<void> {
  for (const upgrade of RUN_COLUMN_UPGRADES) {
    const existing: unknown = await database
      .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
      .get(['runs', upgrade.name])
    if (existing === undefined) await database.exec(upgrade.statement)
  }
}

/**
 * Opens the local ledger, applying the schema every time.
 *
 * Phase 1 uses `@tursodatabase/database`, the local-only package, rather than
 * `@tursodatabase/sync`: the sync package's `url` and `authToken` are required,
 * so there is no remote-less mode to start in. Same engine and same SQL, so the
 * schema carries across to phase 2 unchanged — but phase 2 creates a FRESH
 * synced database and re-ingests from the retained NDJSON rather than
 * converting this file, because a synced database carries change-tracking state
 * a local-only file does not.
 *
 * `exec()` is called once with the whole schema string rather than split
 * statement-by-statement: the driver's own SQL parser walks block comments
 * correctly, and `SCHEMA`'s doc comments themselves contain a `;` (see the
 * `runs` table's leading comment), so a naive split on `;` cuts a comment in
 * half and produces a syntax error. Confirmed against the installed
 * `@tursodatabase/database@0.3.2`.
 */
export async function openLedger(): Promise<Ledger> {
  mkdirSync(ledgerDir(), { recursive: true })

  const database = await connect(databasePath())
  await database.exec(SCHEMA)
  await applyRunColumnUpgrades(database)

  return database
}
