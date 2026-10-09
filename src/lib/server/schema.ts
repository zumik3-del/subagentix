/**
 * opencode SQLite schema adapter (ADR §7.1).
 *
 * This is the single module that knows the JSON shape of `session_v2.model`,
 * `session_message.data` and its `data.content[]` items. Query modules compose
 * SQL from the column builders and helpers below, so the literal `json_extract`
 * and the JSON field paths exist only here (task #184 AC-3).
 *
 * V2 (opencode v2.0.20) removed the `message` and `part` tables: a message's
 * role is the `session_message.type` column, its per-session order is the `seq`
 * column, and the former `part` rows are the `data.content[]` items walked with
 * `json_each` (spec 2026-09-30 §2.1/§3). The legacy `part`-shaped builders and
 * the `message.removed.1` marker mapper are gone with the tables (P3/P4).
 */
import type { TokenCounts } from '../model/token';

/** JSON payload paths. Grouped by table; shared by every query. */
export const JSON_PATH = {
	session: {
		modelId: '$.id',
		providerId: '$.providerID'
	},
	message: {
		/** A `user` message's prompt; V2 stores it here, not as a content item. */
		text: '$.text',
		/** An `assistant` message's provider stop reason (`tool-calls`/`stop`/`error`). */
		finish: '$.finish',
		/** `data.content[]` array path, walked with `json_each(m.data, '$.content')`. */
		content: '$.content',
		agent: '$.agent',
		modelId: '$.model.id',
		providerId: '$.model.providerID',
		cost: '$.cost',
		createdAt: '$.time.created',
		completedAt: '$.time.completed',
		input: '$.tokens.input',
		output: '$.tokens.output',
		reasoning: '$.tokens.reasoning',
		cacheRead: '$.tokens.cache.read',
		cacheWrite: '$.tokens.cache.write'
	},
	/**
	 * `session_message.data.content[]` item paths, read via
	 * `json_each(m.data, '$.content')`. Paths are relative to the item
	 * (`json_each` alias `.value`); `contentColumns` qualifies them.
	 */
	content: {
		itemType: '$.type',
		name: '$.name',
		callId: '$.id',
		status: '$.state.status',
		errorMessage: '$.state.error.message',
		errorType: '$.state.error.type',
		input: '$.state.input',
		content: '$.state.content',
		metadataSessionId: '$.state.metadata.sessionID',
		metadataStatus: '$.state.metadata.status',
		/** An `execute` item's nested Code Mode tool calls (ADR D-2). */
		metadataToolCalls: '$.state.metadata.toolCalls',
		agent: '$.state.input.agent',
		description: '$.state.input.description',
		prompt: '$.state.input.prompt',
		timeCreated: '$.time.created',
		timeRan: '$.time.ran',
		timeCompleted: '$.time.completed',
		text: '$.text'
	},
	/**
	 * Nested Code Mode tool-call entry paths, relative to one entry of an
	 * `execute` item's `state.metadata.toolCalls[]` (ADR D-2). Used by the
	 * dashboard queries to walk the nested array with a second `json_each`.
	 */
	nestedToolCall: {
		tool: '$.tool',
		status: '$.status',
		input: '$.input'
	}
} as const;

/**
 * `session_message.type` discriminator values (V2). The former `data.role` is
 * now this column; only `user`/`assistant` produce turns and steps, the rest
 * are markers or ignored by the assembler (spec §3).
 */
export const MESSAGE_TYPE = {
	user: 'user',
	assistant: 'assistant',
	idle: 'idle',
	system: 'system',
	synthetic: 'synthetic',
	compaction: 'compaction'
} as const;

/** `data.content[].type` discriminator values read via `json_each`. */
export const CONTENT_TYPE = {
	tool: 'tool',
	text: 'text',
	reasoning: 'reasoning'
} as const;

type SqlValue = string | number;

function sqlValue(value: SqlValue): string {
	if (typeof value === 'number') return String(value);
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `json_extract(column, '$.path')`, optionally aliased.
 *
 * The literal `json_extract` intentionally lives here only: query modules call
 * this helper instead of spelling it out (AC-3).
 */
export function jsonExtract(column: string, path: string, alias?: string): string {
	const expression = `json_extract(${column}, '${path}')`;
	return alias ? `${expression} AS ${alias}` : expression;
}

/** `json_extract(column, '$.path') = value` for internal constant values. */
export function jsonEquals(column: string, path: string, value: SqlValue): string {
	return `json_extract(${column}, '${path}') = ${sqlValue(value)}`;
}

/** `json_extract(column, '$.path') IN (...)` for internal constant values. */
export function jsonIn(column: string, path: string, values: readonly SqlValue[]): string {
	return `json_extract(${column}, '${path}') IN (${values.map(sqlValue).join(', ')})`;
}

/** Qualified `session_v2` select list. Always pass the alias used in `FROM`. */
export function sessionColumns(alias: string): string {
	const c = (name: string) => `${alias}.${name}`;
	return [
		c('id'),
		c('parent_id'),
		c('directory'),
		c('title'),
		c('agent'),
		c('time_created'),
		c('time_updated'),
		c('time_archived'),
		c('cost'),
		c('tokens_input'),
		c('tokens_output'),
		c('tokens_reasoning'),
		c('tokens_cache_read'),
		c('tokens_cache_write'),
		jsonExtract(`${alias}.model`, JSON_PATH.session.modelId, 'model_id'),
		jsonExtract(`${alias}.model`, JSON_PATH.session.providerId, 'provider_id')
	].join(', ');
}

/**
 * Qualified `session_message` select list (V2). `role` aliases the `type`
 * column; ordering is by the `seq` column, so both are selected alongside the
 * JSON payload fields (`agent`, `model.*`, cost, times, tokens).
 */
export function messageColumns(alias: string): string {
	const c = (name: string) => `${alias}.${name}`;
	return [
		c('id'),
		c('session_id'),
		`${c('type')} AS role`,
		c('seq'),
		c('time_created'),
		c('time_updated'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.text, 'msg_text'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.finish, 'msg_finish'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.agent, 'agent'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.modelId, 'model_id'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.providerId, 'provider_id'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.cost, 'cost'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.createdAt, 'msg_created'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.completedAt, 'msg_completed'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.input, 'tok_input'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.output, 'tok_output'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.reasoning, 'tok_reasoning'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.cacheRead, 'cache_read'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.cacheWrite, 'cache_write')
	].join(', ');
}

/**
 * Qualified `data.content[]` select list (V2), read with
 * `FROM session_message m, json_each(m.data, '$.content') j`.
 *
 * `itemAlias` is the `json_each` alias (the item paths resolve against
 * `itemAlias.value`). When `messageAlias` is passed, the owning message id/
 * session id and the array index are prepended so the verbatim
 * `mapContentRow` can synthesise a stable item identity (`messageId#index`,
 * spec §3.6/G-6).
 */
export function contentColumns(itemAlias: string, messageAlias?: string): string {
	const value = `${itemAlias}.value`;
	const columns = [
		jsonExtract(value, JSON_PATH.content.itemType, 'item_type'),
		jsonExtract(value, JSON_PATH.content.name, 'item_name'),
		jsonExtract(value, JSON_PATH.content.callId, 'item_call_id'),
		jsonExtract(value, JSON_PATH.content.status, 'item_status'),
		jsonExtract(value, JSON_PATH.content.errorMessage, 'item_error_message'),
		jsonExtract(value, JSON_PATH.content.errorType, 'item_error_type'),
		jsonExtract(value, JSON_PATH.content.input, 'item_input'),
		jsonExtract(value, JSON_PATH.content.content, 'item_content'),
		jsonExtract(value, JSON_PATH.content.metadataSessionId, 'item_metadata_session_id'),
		jsonExtract(value, JSON_PATH.content.metadataStatus, 'item_metadata_status'),
		jsonExtract(value, JSON_PATH.content.metadataToolCalls, 'item_metadata_tool_calls'),
		jsonExtract(value, JSON_PATH.content.agent, 'item_agent'),
		jsonExtract(value, JSON_PATH.content.description, 'item_description'),
		jsonExtract(value, JSON_PATH.content.prompt, 'item_prompt'),
		jsonExtract(value, JSON_PATH.content.timeCreated, 'item_time_created'),
		jsonExtract(value, JSON_PATH.content.timeRan, 'item_time_ran'),
		jsonExtract(value, JSON_PATH.content.timeCompleted, 'item_time_completed'),
		jsonExtract(value, JSON_PATH.content.text, 'item_text')
	];
	if (messageAlias !== undefined) {
		columns.unshift(
			`${messageAlias}.id AS message_id`,
			`${messageAlias}.session_id AS session_id`,
			`${itemAlias}.key AS item_index`
		);
	}
	return columns.join(', ');
}

// ---------------------------------------------------------------------------
// Row shapes (raw SQLite rows are `Record<string, unknown>`).
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

function asString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return typeof value === 'string' ? value : String(value);
}

function asNumber(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : null;
}

function numberOr(value: unknown, fallback: number): number {
	return asNumber(value) ?? fallback;
}

/** Read the five aliased token categories from a mapped row. */
export function tokenCounts(row: Row): TokenCounts {
	return {
		input: numberOr(row.tok_input, 0),
		output: numberOr(row.tok_output, 0),
		reasoning: numberOr(row.tok_reasoning, 0),
		cacheRead: numberOr(row.cache_read, 0),
		cacheWrite: numberOr(row.cache_write, 0)
	};
}

export interface SessionRecord {
	id: string;
	parentId: string | null;
	directory: string;
	title: string;
	agent: string | null;
	modelId: string | null;
	providerId: string | null;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
	cost: number;
	usage: TokenCounts;
}

/** The `session` rollup columns are not JSON; they use their own select list. */
function sessionTokenCounts(row: Row): TokenCounts {
	return {
		input: numberOr(row.tokens_input, 0),
		output: numberOr(row.tokens_output, 0),
		reasoning: numberOr(row.tokens_reasoning, 0),
		cacheRead: numberOr(row.tokens_cache_read, 0),
		cacheWrite: numberOr(row.tokens_cache_write, 0)
	};
}

export function mapSessionRow(row: Row): SessionRecord {
	return {
		id: String(row.id),
		parentId: asString(row.parent_id),
		directory: asString(row.directory) ?? '',
		title: asString(row.title) ?? '',
		agent: asString(row.agent),
		modelId: asString(row.model_id),
		providerId: asString(row.provider_id),
		createdAt: numberOr(row.time_created, 0),
		updatedAt: numberOr(row.time_updated, 0),
		archivedAt: asNumber(row.time_archived),
		cost: numberOr(row.cost, 0),
		usage: sessionTokenCounts(row)
	};
}

export interface SessionSummaryRecord extends SessionRecord {
	childCount: number;
}

export function mapSessionSummaryRow(row: Row): SessionSummaryRecord {
	return { ...mapSessionRow(row), childCount: numberOr(row.child_count, 0) };
}

export interface MessageRecord {
	id: string;
	sessionId: string;
	/** `session_message.seq`: per-session total order (V2 replaces `data.parentID`). */
	seq: number;
	createdAt: number;
	updatedAt: number;
	/** The `session_message.type` column (`user`/`assistant`/…). */
	role: string | null;
	/** `data.text`: the prompt of a `user` message (V2 keeps no `content[]` for it). */
	text: string | null;
	/** `data.finish`: an `assistant` message's provider stop reason. */
	finish: string | null;
	agent: string | null;
	modelId: string | null;
	providerId: string | null;
	cost: number;
	usage: TokenCounts;
	/** `data.time.created` (turn anchor); falls back to the row timestamp. */
	startedAt: number;
	completedAt: number | null;
}

export function mapMessageRow(row: Row): MessageRecord {
	const createdAt = numberOr(row.time_created, 0);
	return {
		id: String(row.id),
		sessionId: String(row.session_id),
		seq: numberOr(row.seq, 0),
		createdAt,
		updatedAt: numberOr(row.time_updated, 0),
		role: asString(row.role),
		text: asString(row.msg_text),
		finish: asString(row.msg_finish),
		agent: asString(row.agent),
		modelId: asString(row.model_id),
		providerId: asString(row.provider_id),
		cost: numberOr(row.cost, 0),
		usage: tokenCounts(row),
		startedAt: numberOr(row.msg_created, createdAt),
		completedAt: asNumber(row.msg_completed)
	};
}

/**
 * A `session_message`-derived turn projection (task #383): one trigger row plus
 * the number of assistant messages between it and the next trigger (V2: by
 * `seq` window, not `data.parentID`). No payload columns are read.
 */
export interface TurnSummaryRecord {
	/** Trigger (`type='user'`) message id. */
	id: string;
	/** Trigger `session_message.time_created`, epoch-ms. */
	startedAt: number;
	/** Assistant messages between this trigger and the next, by `seq`. */
	assistantCount: number;
}

export function mapTurnSummaryRow(row: Row): TurnSummaryRecord {
	return {
		id: String(row.id),
		startedAt: numberOr(row.started_at, 0),
		assistantCount: numberOr(row.assistant_count, 0)
	};
}

/**
 * One nested Code Mode tool call inside an `execute` item's
 * `state.metadata.toolCalls[]` (ADR D-2). `input` is the raw JSON text of the
 * entry's `input` value (an object in the live payload); `null` when absent.
 */
export interface NestedToolCall {
	tool: string;
	status: string;
	input: string | null;
}

/**
 * Parse an `execute` item's `state.metadata.toolCalls` raw JSON text into
 * {@link NestedToolCall} DTOs. Safe by construction: `[]` on absent, malformed
 * or non-array input; non-object entries are skipped; a missing/non-string
 * `tool`/`status` coerces to `''`; a missing `input` becomes `null`, an object
 * is re-serialised to JSON text, a string is kept verbatim.
 */
export function parseNestedToolCalls(raw: string | null): NestedToolCall[] {
	if (raw === null || raw === '') return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const calls: NestedToolCall[] = [];
	for (const entry of parsed) {
		if (entry === null || typeof entry !== 'object') continue;
		const record = entry as Record<string, unknown>;
		calls.push({
			tool: typeof record.tool === 'string' ? record.tool : '',
			status: typeof record.status === 'string' ? record.status : '',
			input:
				record.input === undefined || record.input === null
					? null
					: typeof record.input === 'string'
						? record.input
						: JSON.stringify(record.input)
		});
	}
	return calls;
}

/**
 * One `data.content[]` item of a `session_message` (V2), walked with
 * `json_each` and selected via {@link contentColumns}: the item has no row id,
 * so identity is `(messageId, index)` — the synthesised `id` and `callId` is the
 * provider call id (`item.id`), which is not globally unique (spec §3.6/G-6).
 */
export interface ContentRecord {
	/** Synthesised identity `messageId#index` (the item has no row id). */
	id: string;
	messageId: string;
	sessionId: string;
	/** 0-based index of the item within the owning message's `content[]`. */
	index: number;
	type: string | null;
	name: string | null;
	/** Provider call id (`item.id`), e.g. `call_function_*`; not globally unique. */
	callId: string | null;
	/** `state.status` (`completed`/`error`/`running`). */
	status: string | null;
	/** `state.error.message` (V2 `state.error` is an object). */
	errorMessage: string | null;
	/** `state.error.type`. */
	errorType: string | null;
	/** `state.input` as raw JSON text. */
	input: string | null;
	/** `state.content` as raw JSON text (`text`/`file` output items). */
	content: string | null;
	/** `state.metadata.sessionID` (subagent delegation child). */
	metadataSessionId: string | null;
	/** `state.metadata.status`. */
	metadataStatus: string | null;
	/** `state.input.agent` (subagent type). */
	agent: string | null;
	/** `state.input.description` (subagent description). */
	description: string | null;
	/** `state.input.prompt` (subagent prompt). */
	prompt: string | null;
	/** Item `time.created`; `null` for `text` items, which carry no time. */
	timeCreated: number | null;
	/** Item `time.ran` (tool items only). */
	timeRan: number | null;
	/** Item `time.completed`; `null` while the tool is still running. */
	timeCompleted: number | null;
	/** Item body (`text`/`reasoning` items; `null` for `tool` items). */
	text: string | null;
	/**
	 * Nested Code Mode tool calls (`state.metadata.toolCalls[]`, ADR D-2);
	 * `[]` for items without nested calls (plain JS `execute`, `text`, …).
	 */
	toolCalls: NestedToolCall[];
}

export function mapContentRow(row: Row): ContentRecord {
	const messageId = asString(row.message_id) ?? '';
	const index = numberOr(row.item_index, 0);
	return {
		id: `${messageId}#${index}`,
		messageId,
		sessionId: asString(row.session_id) ?? '',
		index,
		type: asString(row.item_type),
		name: asString(row.item_name),
		callId: asString(row.item_call_id),
		status: asString(row.item_status),
		errorMessage: asString(row.item_error_message),
		errorType: asString(row.item_error_type),
		input: asString(row.item_input),
		content: asString(row.item_content),
		metadataSessionId: asString(row.item_metadata_session_id),
		metadataStatus: asString(row.item_metadata_status),
		agent: asString(row.item_agent),
		description: asString(row.item_description),
		prompt: asString(row.item_prompt),
		timeCreated: asNumber(row.item_time_created),
		timeRan: asNumber(row.item_time_ran),
		timeCompleted: asNumber(row.item_time_completed),
		text: asString(row.item_text),
		toolCalls: parseNestedToolCalls(asString(row.item_metadata_tool_calls))
	};
}

/**
 * A delegation edge: a `subagent` `data.content[]` item reduced to edge fields
 * (V2 replaced V1's `part.tool='task'`; spec §P3). Content items have no row id,
 * so `id` is the synthesised `messageId#index`.
 */
export interface DelegationRecord {
	id: string;
	sessionId: string;
	messageId: string;
	createdAt: number;
	parentSessionId: string | null;
	childSessionId: string | null;
	subagentType: string | null;
	status: string;
	error: string | null;
	startedAt: number | null;
	endedAt: number | null;
	resultBytes: number;
	description: string | null;
	prompt: string | null;
}

/** Hard cap on materialised tool output (chars), spec §3.10/E-10. */
export const TOOL_OUTPUT_CAP = 16_384;

/**
 * The `text` items of a tool's raw `state.content` JSON array, in document
 * order. `file` items (base64 payloads) and non-`text` items are skipped by
 * construction; a `null`/blank/malformed/non-array value yields `[]`. This is
 * the one JSON walk shared by the tool-output readers, so `resultBytes` and the
 * materialised output cannot diverge (spec §3.10/E-10).
 */
export function contentTextItems(rawContent: string | null): string[] {
	if (rawContent === null || rawContent === '') return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawContent);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const texts: string[] = [];
	for (const item of parsed) {
		if (item === null || typeof item !== 'object') continue;
		const record = item as Record<string, unknown>;
		if (record.type !== 'text') continue;
		if (typeof record.text === 'string') texts.push(record.text);
	}
	return texts;
}

/**
 * Concatenate the `text` items of a tool's `state.content[]` (skipping `file`
 * items), capped at {@link TOOL_OUTPUT_CAP} chars (spec §3.10/E-10). Returns
 * `null` when the tool produced no text output.
 */
export function toolOutputText(rawContent: string | null): string | null {
	const parts = contentTextItems(rawContent).filter((text) => text !== '');
	if (parts.length === 0) return null;
	const joined = parts.join('\n');
	return joined.length > TOOL_OUTPUT_CAP ? joined.slice(0, TOOL_OUTPUT_CAP) : joined;
}

