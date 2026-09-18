/**
 * Transaction helper for node:sqlite.
 *
 * Since node:sqlite's DatabaseSync is synchronous, transactions are also synchronous.
 */

import type { DatabaseSync } from 'node:sqlite';

/**
 * Execute a function within a database transaction.
 * The transaction is committed if the function returns, rolled back if it throws.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
