/**
 * opencode SQLite schema adapter (ADR §7.1).
 *
 * This is the single module that knows the JSON shape of `message.data`,
 * `part.data`, `event.data` and `session.model`. Query modules compose SQL from
 * the column builders and helpers below, so the literal `json_extract` and the
 * JSON field paths exist only here (task #184 AC-3).
 */
import type { TokenCounts } from '../model/token';

/** JSON payload paths. Grouped by table; shared by every query. */
export const JSON_PATH = {
	session: {
		modelId: '$.id',
		providerId: '$.providerID'
	},
	message: {
		role: '$.role',
		parentId: '$.parentID',
		agent: '$.agent',
		modelId: '$.modelID',
		providerId: '$.providerID',
		cost: '$.cost',
		createdAt: '$.time.created',
		completedAt: '$.time.completed',
		input: '$.tokens.input',
		output: '$.tokens.output',
		reasoning: '$.tokens.reasoning',
		cacheRead: '$.tokens.cache.read',
		cacheWrite: '$.tokens.cache.write'
	},
	part: {
		type: '$.type',
		tool: '$.tool',
		callId: '$.callID',
		status: '$.state.status',
		error: '$.state.error',
		stateStart: '$.state.time.start',
		stateEnd: '$.state.time.end',
		stateInput: '$.state.input',
		stateOutput: '$.state.output',
		parentSessionId: '$.state.metadata.parentSessionId',
		childSessionId: '$.state.metadata.sessionId',
		subagentType: '$.state.input.subagent_type',
		description: '$.state.input.description',
		prompt: '$.state.input.prompt',
		reason: '$.reason',
		auto: '$.auto',
		cost: '$.cost',
		timeStart: '$.time.start',
		timeEnd: '$.time.end',
		text: '$.text',
		filename: '$.filename',
		mime: '$.mime',
		files: '$.files',
		hash: '$.hash',
		agentName: '$.name',
		input: '$.tokens.input',
		output: '$.tokens.output',
		reasoning: '$.tokens.reasoning',
		cacheRead: '$.tokens.cache.read',
		cacheWrite: '$.tokens.cache.write'
	},
	event: {
		messageId: '$.messageID',
		sessionId: '$.sessionID'
	}
} as const;

/** `part.data.type` discriminator values used by the queries. */
export const PART_TYPE = {
	stepStart: 'step-start',
	stepFinish: 'step-finish',
	tool: 'tool',
	compaction: 'compaction',
	text: 'text',
	reasoning: 'reasoning',
	patch: 'patch',
	file: 'file',
	agent: 'agent'
} as const;

/** `event.type` values used by the queries. */
export const EVENT_TYPE = {
	messageRemoved: 'message.removed.1'
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

/** Qualified `session` select list. Always pass the alias used in `FROM`. */
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

/** Qualified `message` select list. */
export function messageColumns(alias: string): string {
	const c = (name: string) => `${alias}.${name}`;
	return [
		c('id'),
		c('session_id'),
		c('time_created'),
		c('time_updated'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.role, 'role'),
		jsonExtract(`${alias}.data`, JSON_PATH.message.parentId, 'parent_id'),
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

/** Qualified `part` select list. */
export function partColumns(alias: string): string {
	const c = (name: string) => `${alias}.${name}`;
	return [
		c('id'),
		c('message_id'),
		c('session_id'),
		c('time_created'),
		c('time_updated'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.type, 'type'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.tool, 'tool'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.callId, 'call_id'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.status, 'state_status'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.error, 'state_error'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.stateStart, 'state_start'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.stateEnd, 'state_end'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.stateInput, 'state_input'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.stateOutput, 'state_output'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.parentSessionId, 'parent_session_id'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.childSessionId, 'child_session_id'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.subagentType, 'subagent_type'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.description, 'description'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.prompt, 'prompt'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.reason, 'reason'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.auto, 'auto'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.cost, 'cost'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.timeStart, 'part_start'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.timeEnd, 'part_end'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.input, 'tok_input'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.output, 'tok_output'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.reasoning, 'tok_reasoning'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.cacheRead, 'cache_read'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.cacheWrite, 'cache_write'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.text, 'part_text'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.filename, 'part_filename'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.mime, 'part_mime'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.files, 'part_files'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.hash, 'part_hash'),
		jsonExtract(`${alias}.data`, JSON_PATH.part.agentName, 'part_agent_name')
	].join(', ');
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
	createdAt: number;
	updatedAt: number;
	role: string | null;
	parentId: string | null;
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
		createdAt,
		updatedAt: numberOr(row.time_updated, 0),
		role: asString(row.role),
		parentId: asString(row.parent_id),
		agent: asString(row.agent),
		modelId: asString(row.model_id),
		providerId: asString(row.provider_id),
		cost: numberOr(row.cost, 0),
		usage: tokenCounts(row),
		startedAt: numberOr(row.msg_created, createdAt),
		completedAt: asNumber(row.msg_completed)
	};
}

export interface PartRecord {
	id: string;
	messageId: string;
	sessionId: string;
	createdAt: number;
	updatedAt: number;
	type: string | null;
	tool: string | null;
	callId: string | null;
	status: string | null;
	error: string | null;
	stateStart: number | null;
	stateEnd: number | null;
	input: string | null;
	output: string | null;
	parentSessionId: string | null;
	childSessionId: string | null;
	subagentType: string | null;
	description: string | null;
	prompt: string | null;
	reason: string | null;
	auto: number | null;
	/** `reasoning`/`text` parts carry `data.time.{start,end}`. */
	partStart: number | null;
	partEnd: number | null;
	/** `text`/`reasoning` part body (`data.text`). */
	text: string | null;
	/** `file` part: attachment display name and MIME type. */
	filename: string | null;
	mime: string | null;
	/** `patch` part: changed file paths as a JSON array text. */
	files: string | null;
	/** `patch` part: git blob hash. */
	hash: string | null;
	/** `agent` part: mentioned agent name (`data.name`). */
	agentName: string | null;
	usage: TokenCounts;
	cost: number;
}

export function mapPartRow(row: Row): PartRecord {
	return {
		id: String(row.id),
		messageId: String(row.message_id),
		sessionId: String(row.session_id),
		createdAt: numberOr(row.time_created, 0),
		updatedAt: numberOr(row.time_updated, 0),
		type: asString(row.type),
		tool: asString(row.tool),
		callId: asString(row.call_id),
		status: asString(row.state_status),
		error: asString(row.state_error),
		stateStart: asNumber(row.state_start),
		stateEnd: asNumber(row.state_end),
		input: asString(row.state_input),
		output: asString(row.state_output),
		parentSessionId: asString(row.parent_session_id),
		childSessionId: asString(row.child_session_id),
		subagentType: asString(row.subagent_type),
		description: asString(row.description),
		prompt: asString(row.prompt),
		reason: asString(row.reason),
		auto: asNumber(row.auto),
		partStart: asNumber(row.part_start),
		partEnd: asNumber(row.part_end),
		text: asString(row.part_text),
		filename: asString(row.part_filename),
		mime: asString(row.part_mime),
		files: asString(row.part_files),
		hash: asString(row.part_hash),
		agentName: asString(row.part_agent_name),
		usage: tokenCounts(row),
		cost: numberOr(row.cost, 0)
	};
}

/** A delegation row: `part.tool='task'` reduced to edge fields. */
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

export function mapDelegationRow(row: Row): DelegationRecord {
	const output = asString(row.state_output);
	return {
		id: String(row.id),
		sessionId: String(row.session_id),
		messageId: String(row.message_id),
		createdAt: numberOr(row.time_created, 0),
		parentSessionId: asString(row.parent_session_id),
		childSessionId: asString(row.child_session_id),
		subagentType: asString(row.subagent_type),
		status: asString(row.state_status) ?? 'unknown',
		error: asString(row.state_error),
		startedAt: asNumber(row.state_start),
		endedAt: asNumber(row.state_end),
		resultBytes: output?.length ?? 0,
		description: asString(row.description),
		prompt: asString(row.prompt)
	};
}

/** A `message.removed.1` event reduced to its ids. */
export interface RemovedMarkerRecord {
	sessionId: string;
	messageId: string | null;
}

export function mapRemovedMarkerRow(row: Row): RemovedMarkerRecord {
	return {
		sessionId: asString(row.session_id) ?? '',
		messageId: asString(row.message_id)
	};
}
