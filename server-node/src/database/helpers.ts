/**
 * Database type helpers for node:sqlite.
 *
 * The node:sqlite module returns Record<string, SQLOutputValue> from queries.
 * These helpers cast to our typed interfaces.
 */

import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite';

/**
 * Type-safe query helper that casts results to the expected type.
 */
export function queryAll<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

/**
 * Type-safe query helper for single row.
 */
export function queryOne<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/**
 * Type-safe prepared statement query helper.
 */
export function stmtAll<T>(stmt: StatementSync, ...params: SQLInputValue[]): T[] {
  return stmt.all(...params) as unknown as T[];
}

/**
 * Type-safe prepared statement query helper for single row.
 */
export function stmtOne<T>(stmt: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return stmt.get(...params) as unknown as T | undefined;
}
