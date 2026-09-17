/**
 * Dashboard query entry point (Phase 1 #403 / Phase 2 #406/#407).
 *
 * The tier-scoped aggregates live in their own modules — `dashboard-sessions.ts`
 * (Tier-S, `session`-only, plus the shared session-id resolver), and
 * `dashboard-message.ts` (Tier-M, `message`) / `dashboard-tools.ts` (Tier-P,
 * `part`) — which read the large tables only for the sessions resolved in the
 * window/scope, in chunks under SQLite's variable limit; `event` stays
 * untouched. This module re-exports that public surface so callers
 * (`services/dashboard*.ts`, the widget endpoint, the query suite) keep one
 * stable import path; the shared window shape and chunking helpers live in
 * `dashboard-shared.ts` and are not duplicated per tier.
 */
export {
	DEFAULT_TOP_N,
	IN_CHUNK_SIZE,
	type DashboardWindow
} from './dashboard-shared';
export {
	aggregateSessionTotals,
	countSessionsByAgent,
	countSessionsByDirectory,
	countSessionsByModel,
	countSessionsByProvider,
	countSessionsByUtcDay,
	listSessionIds,
	type DayCountRecord,
	type DirectoryCountRecord,
	type NamedCountRecord,
	type SessionTotalsRecord
} from './dashboard-sessions';
export { aggregateMessageUsageByUtcDay, type MessageDayRecord } from './dashboard-message';
export {
	aggregateToolUsage,
	type ToolKindSelection,
	type ToolUsageRecord
} from './dashboard-tools';
