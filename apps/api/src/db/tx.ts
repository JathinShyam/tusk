import type { TransactionSql } from "postgres";
import type { Db } from "./client.js";

/**
 * RLS session context (TRD §6). Everything is transaction-local via
 * `set_config(..., true)` so the pool stays PgBouncer transaction-mode safe
 * (TR-C-008); session-level SET is never used.
 *
 * Values are only written when present: `set_config(name, NULL, true)` stores
 * an empty string instead of clearing the parameter. Note that once a pooled
 * session has run any SET LOCAL, reverted custom GUCs read back as '' rather
 * than NULL — every policy casts through nullif(..., '') so both states mean
 * "no context" and filter every row ("no settings => zero rows").
 */
export type RlsContext = {
  tenantId?: string | null;
  userId?: string | null;
  role?: string | null;
  /** Set only by provisioning paths (register self-tenant, platform tenant create). */
  bootstrap?: boolean;
  statementTimeoutMs?: number;
};

const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

export async function withRls<T>(
  db: Db,
  ctx: RlsContext,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await db.begin(async (tx) => {
    if (ctx.tenantId) {
      await tx`select set_config('app.tenant_id', ${ctx.tenantId}, true)`;
    }
    if (ctx.userId) {
      await tx`select set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.role) {
      await tx`select set_config('app.role', ${ctx.role}, true)`;
    }
    if (ctx.bootstrap) {
      await tx`select set_config('app.bootstrap', 'true', true)`;
    }
    // TR-PERF-005: 5s statement budget for API transactions.
    await tx`select set_config('statement_timeout', ${String(
      ctx.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    )}, true)`;
    return fn(tx);
  });
  return result as T;
}
