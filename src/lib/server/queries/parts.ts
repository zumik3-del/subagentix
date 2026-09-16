/**
 * Session-scoped part reads (ADR §6.2–6.3).
 *
 * Every query filters on `session_id = :sid` (or `aggregate_id = :sid` for the
 * `event` marker source) so SQLite uses `part_session_idx` /
 * `event_aggregate_type_seq_idx` instead of a full table scan. The step, tool
 * and action reads additionally accept an optional `message_id` scope (task
 * #386) so turning one root turn never loads another turn's rows into JS.
 */
import { getDb } from '../db';
import {
	jsonEquals,
	jsonExtract,
	jsonIn,
	mapMessageRow,
	mapPartRow,
	mapRemovedMarkerRow,
	mapTurnSummaryRow,
	messageColumns,
	partColumns,
	EVENT_TYPE,
	JSON_PATH,
	PART_TYPE,
	type MessageRecord,
	type PartRecord,
	type RemovedMarkerRecord,
	type Row,
	type TurnSummaryRecord
} from '../schema';

/**
 * SQL fragment scoping a `part` read to an explicit `message_id` set (task
 * #386): `AND part.message_id IN (?, ...)`. `undefined` means "no scope"
 * (unchanged); an empty list means "no messages" and short-circuits to `AND 0`
 * without loading a single row. Every id is a bound parameter.
 */
function messageScope(messageIds?: readonly string[]): { clause: string; values: string[] } {
	if (messageIds === undefined) return { clause: '', values: [] };
	if (messageIds.length === 0) return { clause: ' AND 0', values: [] };
	return {
		clause: ` AND part.message_id IN (${messageIds.map(() => '?').join(', ')})`,
		values: [...messageIds]
	};
}

/** All messages of one session, oldest first. */
export function getMessages(sessionId: string): MessageRecord[] {
	const sql = `
		SELECT ${messageColumns('message')}
		FROM message
		WHERE message.session_id = :sid
		ORDER BY message.time_created, message.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapMessageRow);
}

/**
 * Root-session turn projections, ordered by trigger `time_created` (task #383).
 *
 * One SQL pass: the trigger rows (`role='user'`) and their assistant counts are
 * aggregated in SQLite, so only one compact row per turn crosses into JS. Unlike
 * {@link getMessages}, no message payload is ever loaded.
 */
export function getTurnSummaries(sessionId: string): TurnSummaryRecord[] {
	const userFilter = jsonEquals('trigger_msg.data', JSON_PATH.message.role, 'user');
	const assistantFilter = jsonEquals('assistant_msg.data', JSON_PATH.message.role, 'assistant');
	const parentMatch = `${jsonExtract('assistant_msg.data', JSON_PATH.message.parentId)} = trigger_msg.id`;
	const sql = `
		SELECT trigger_msg.id AS id,
			trigger_msg.time_created AS started_at,
			count(assistant_msg.id) AS assistant_count
		FROM message AS trigger_msg
		LEFT JOIN message AS assistant_msg
			ON assistant_msg.session_id = trigger_msg.session_id
			AND ${assistantFilter}
			AND ${parentMatch}
		WHERE trigger_msg.session_id = :sid AND ${userFilter}
		GROUP BY trigger_msg.id
		ORDER BY trigger_msg.time_created, trigger_msg.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapTurnSummaryRow);
}

/**
 * Step parts of one session: `step-start` (opens a step) and `step-finish`
 * (closes it, carries the canonical usage). Ordered so the assembler can pair
 * them deterministically. When `messageIds` is given, only those messages'
 * parts are read (the callers already restrict to the same set in JS).
 */
export function getStepParts(sessionId: string, messageIds?: readonly string[]): PartRecord[] {
	const typeFilter = jsonIn('part.data', JSON_PATH.part.type, [
		PART_TYPE.stepStart,
		PART_TYPE.stepFinish
	]);
	const scope = messageScope(messageIds);
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = ? AND ${typeFilter}${scope.clause}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all(sessionId, ...scope.values) as Row[];
	return rows.map(mapPartRow);
}

/** Tool / MCP parts of one session; optional `message_id` scope as above. */
export function getToolParts(sessionId: string, messageIds?: readonly string[]): PartRecord[] {
	const typeFilter = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.tool);
	const scope = messageScope(messageIds);
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = ? AND ${typeFilter}${scope.clause}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all(sessionId, ...scope.values) as Row[];
	return rows.map(mapPartRow);
}

/**
 * Non-tool action parts of one session (M-unified timeline): `text`,
 * `reasoning`, `patch`, `file` and `agent` mentions. Compaction is fetched
 * separately by {@link getCompactionParts} and merged by the assembler.
 * Optional `message_id` scope as above.
 */
export function getActionParts(sessionId: string, messageIds?: readonly string[]): PartRecord[] {
	const typeFilter = jsonIn('part.data', JSON_PATH.part.type, [
		PART_TYPE.text,
		PART_TYPE.reasoning,
		PART_TYPE.patch,
		PART_TYPE.file,
		PART_TYPE.agent
	]);
	const scope = messageScope(messageIds);
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = ? AND ${typeFilter}${scope.clause}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all(sessionId, ...scope.values) as Row[];
	return rows.map(mapPartRow);
}

/** Compaction markers of one session (never a token subtraction). */
export function getCompactionParts(sessionId: string): PartRecord[] {
	const typeFilter = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.compaction);
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = :sid AND ${typeFilter}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapPartRow);
}

/**
 * `message.removed` events of one session (spec EC-3). The event payload keeps
 * only ids, never content, so these become markers only.
 */
export function getRemovedMarkers(sessionId: string): RemovedMarkerRecord[] {
	const sql = `
		SELECT event.aggregate_id AS session_id,
			${jsonExtract('event.data', JSON_PATH.event.messageId, 'message_id')}
		FROM event
		WHERE event.aggregate_id = :sid AND event.type = :type
		ORDER BY event.seq`;
	const rows = getDb()
		.query(sql)
		.all({ ':sid': sessionId, ':type': EVENT_TYPE.messageRemoved }) as Row[];
	return rows.map(mapRemovedMarkerRow);
}
