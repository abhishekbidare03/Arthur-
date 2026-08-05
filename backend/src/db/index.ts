/**
 * SQLite connection and schema setup.
 *
 * `better-sqlite3` ships prebuilt binaries for Node 22, so this installs with
 * no MSVC toolchain — consistent with the rest of the stack. It is synchronous
 * by design, which is the right shape here: queries are sub-millisecond against
 * a local file, and the alternative would be threading promises through every
 * call site for no gain.
 */

import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DB_PATH } from '../config.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** Bumped when `schema.sql` changes in a way that needs a migration step. */
const SCHEMA_VERSION = 1

function open(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true })

  const db = new Database(DB_PATH)

  // Write-ahead logging: a reader is never blocked by the writer, and an
  // unclean shutdown (closing the Chrome window mid-stream) recovers rather
  // than corrupting. `NORMAL` is the right durability trade for a local app —
  // `FULL` fsyncs on every commit and would stutter while streaming.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  // Off by default in SQLite, and the schema leans on cascade deletes.
  db.pragma('foreign_keys = ON')

  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0

  // The schema is written with IF NOT EXISTS throughout, so running it on an
  // existing database is a no-op. Future versions add migration steps here.
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))

  if (current !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  return db
}

export const db = open()

/** ISO-8601 timestamp, the format the whole app stores and the UI parses. */
export function now(): string {
  return new Date().toISOString()
}

export function newId(): string {
  return crypto.randomUUID()
}

/** Flush the WAL and close cleanly. Called on shutdown. */
export function closeDb(): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
  } catch {
    // Already closed, or closing during a crash — nothing useful to do.
  }
}
