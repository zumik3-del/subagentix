/**
 * Shared opencode V2 fixture (spec `2026-09-30-opencode-v2-db-schema-migration`
 * §7). One module every suite imports, replacing the 22 inline V1
 * `CREATE TABLE` blocks.
 *
 * The DDL mirrors the live DB `sqlite_schema` (spec §2.1) and every seed
 * helper reproduces the *observed* payload shapes (spec §2.2/§3): `state.error`
 * is an object `{type,message}`, a `subagent` item carries
 * `state.metadata.{sessionID,status,truncated}`, `text` items carry no time
 * field, and tool output lives in `state.content[]` as `text`/`file` items.
 *
 * The file name has no `.test`/`.suite` suffix, so the bun test glob ignores it
 * (same convention as `data-layer.suite.ts`); suites import it directly.
 */
import type { Database } from 'bun:sqlite';

/** Shared epoch base for fixture timestamps (`1_700_000_000_000`). */
export const T = 1_700_000_000_000;

/** `session_v2.project_id` is `NOT NULL`; this is the default fixture project. */
export const PROJECT_ID = 'proj_fixture';

/** The five token categories as they appear under `data.tokens` (spec §3.1). */
export interface TokenSeed {
	input?: number;
	output?: number;
	reasoning?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** `data.tokens` payload: `{input, output, reasoning, cache:{read,write}}`. */
function tokensPayload(tokens: TokenSeed = {}): Record<string, unknown> {
	return {
		input: tokens.input ?? 0,
		output: tokens.output ?? 0,
		reasoning: tokens.reasoning ?? 0,
		cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 }
	};
}

/**
 * Create the opencode V2 schema (spec §2.1): `project` (the FK target),
 * `session_v2`, `session_message` and the six indexes the live DB declares.
 * Idempotent only in the sense that it must be run on an empty database.
 */
export function applyV2Schema(db: Database): void {
	db.exec(`
		CREATE TABLE project (
			id TEXT PRIMARY KEY,
			worktree TEXT NOT NULL,
			name TEXT,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			time_active INTEGER NOT NULL DEFAULT 0,
			sandboxes TEXT NOT NULL
		);

		CREATE TABLE session_v2 (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT,
			slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT,
			version TEXT NOT NULL, share_url TEXT,
			summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
			summary_diffs TEXT, metadata TEXT,
			cost REAL NOT NULL DEFAULT 0,
			tokens_input INTEGER NOT NULL DEFAULT 0,
			tokens_output INTEGER NOT NULL DEFAULT 0,
			tokens_reasoning INTEGER NOT NULL DEFAULT 0,
			tokens_cache_read INTEGER NOT NULL DEFAULT 0,
			tokens_cache_write INTEGER NOT NULL DEFAULT 0,
			revert TEXT, permission TEXT, agent TEXT, model TEXT,
			time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
			time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT,
			time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER,
			resume_attempts INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
		);
		CREATE INDEX session_v2_parent_idx ON session_v2(parent_id);
		CREATE INDEX session_v2_project_idx ON session_v2(project_id);

		CREATE TABLE session_message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			type TEXT NOT NULL,
			seq INTEGER NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
		);
		CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
		CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);
		CREATE INDEX session_message_session_time_created_id_idx ON session_message(session_id, time_created, id);
		CREATE INDEX session_message_time_created_idx ON session_message(time_created);
	`);
}

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

export interface ProjectSeed {
	/** Defaults to {@link PROJECT_ID}, the default `session_v2.project_id`. */
	id?: string;
	worktree?: string;
	name?: string | null;
	created?: number;
	updated?: number;
	/** JSON array text; the live column stores `'[]'` when no sandboxes exist. */
	sandboxes?: string;
}

/**
 * Insert one `project` row — the FK target `session_v2.project_id` points at, so
 * every fixture that seeds sessions needs one first.
 */
export function addProject(db: Database, seed: ProjectSeed = {}): void {
	db.prepare(
		'INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)'
	).run(
		seed.id ?? PROJECT_ID,
		seed.worktree ?? '/',
		seed.name ?? null,
		seed.created ?? 0,
		seed.updated ?? 0,
		seed.sandboxes ?? '[]'
	);
}

// ---------------------------------------------------------------------------
// session_v2
// ---------------------------------------------------------------------------

export interface SessionV2Seed {
	id: string;
	/** Subagent parent session (`session_v2.parent_id`) or root when omitted. */
	parentId?: string | null;
	/** Working directory (spec §7 uses `dir`). */
	dir: string;
	title?: string | null;
	agent?: string | null;
	created: number;
	updated?: number;
	archived?: number | null;
	cost?: number;
	tokens?: TokenSeed;
	/** `session_v2.model` JSON: `{id, providerID}`. */
	model?: { id: string; providerID: string } | null;
	projectId?: string;
	slug?: string;
	version?: string;
}

/** Insert one `session_v2` row. */
export function addSessionV2(db: Database, seed: SessionV2Seed): void {
	db.prepare(
		`INSERT INTO session_v2 (
			id, project_id, parent_id, slug, directory, title, agent, model, cost, version,
			tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
			time_created, time_updated, time_archived
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		seed.id,
		seed.projectId ?? PROJECT_ID,
		seed.parentId ?? null,
		seed.slug ?? seed.id,
		seed.dir,
		seed.title ?? null,
		seed.agent ?? null,
		seed.model ? JSON.stringify(seed.model) : null,
		seed.cost ?? 0,
		seed.version ?? '2.0.20',
		seed.tokens?.input ?? 0,
		seed.tokens?.output ?? 0,
		seed.tokens?.reasoning ?? 0,
		seed.tokens?.cacheRead ?? 0,
		seed.tokens?.cacheWrite ?? 0,
		seed.created,
		seed.updated ?? seed.created,
		seed.archived ?? null
	);
}

/** Point a subagent's `session_v2.parent_id` at its orchestrator session. */
export function linkParent(db: Database, childId: string, parentId: string): void {
	db.prepare('UPDATE session_v2 SET parent_id = ? WHERE id = ?').run(parentId, childId);
}

// ---------------------------------------------------------------------------
// session_message
// ---------------------------------------------------------------------------

interface MessageRow {
	id: string;
	sessionId: string;
	type: string;
	seq: number;
	created: number;
	updated?: number;
	data: Record<string, unknown>;
}

/** Low-level `session_message` insert (`data` is JSON-stringified). */
export function addMessage(db: Database, row: MessageRow): void {
	db.prepare(
		'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
	).run(row.id, row.sessionId, row.type, row.seq, row.created, row.updated ?? row.created, JSON.stringify(row.data));
}

export interface UserMessageSeed {
	id: string;
	sessionId: string;
	seq: number;
	created: number;
	updated?: number;
	text: string;
	files?: unknown[];
}

/** A `user` trigger message: `data.text` + `data.files[]`, no `content[]`. */
export function addUserMessage(db: Database, seed: UserMessageSeed): void {
	addMessage(db, {
		...seed,
		type: 'user',
		data: { time: { created: seed.created }, text: seed.text, files: seed.files ?? [] }
	});
}

export interface AssistantMessageSeed {
	id: string;
	sessionId: string;
	seq: number;
	created: number;
	updated?: number;
	/** `data.time.completed`; omit for an open message (E-1). */
	completed?: number;
	agent?: string | null;
	model?: { id: string; providerID: string } | null;
	/** `data.finish` (`tool-calls`/`stop`/`error`/blank). */
	finish?: string;
	cost?: number;
	tokens?: TokenSeed;
	/** `data.content[]` items; build with {@link toolItem}/{@link reasoningItem}/{@link textItem}. */
	content?: ContentItem[];
}

/**
 * An `assistant` message: the V2 step carrier. `content[]` holds the
 * tool/reasoning/text items; `data.tokens`/`data.finish`/`data.model` carry the
 * step usage.
 */
export function addAssistantMessage(db: Database, seed: AssistantMessageSeed): void {
	addMessage(db, {
		...seed,
		type: 'assistant',
		data: {
			time: { created: seed.created, ...(seed.completed !== undefined ? { completed: seed.completed } : {}) },
			agent: seed.agent ?? 'build',
			model: seed.model ?? { id: 'test-model', providerID: 'test-provider', variant: 'default' },
			content: seed.content ?? [],
			finish: seed.finish ?? 'stop',
			cost: seed.cost ?? 0,
			tokens: tokensPayload(seed.tokens)
		}
	});
}

export interface CompactionMessageSeed {
	id: string;
	sessionId: string;
	seq: number;
	created: number;
	updated?: number;
	summary?: string;
	status?: string;
	reason?: string;
	model?: { id: string; providerID: string; variant?: string } | null;
	tokens?: TokenSeed;
	cost?: number;
}

/** A `compaction` message (spec §3.5): was a `part`, now its own message. */
export function addCompactionMessage(db: Database, seed: CompactionMessageSeed): void {
	addMessage(db, {
		...seed,
		type: 'compaction',
		data: {
			time: { created: seed.created },
			status: seed.status ?? 'completed',
			reason: seed.reason ?? 'auto',
			model: seed.model ?? { id: 'test-model', providerID: 'test-provider', variant: 'default' },
			summary: seed.summary ?? '',
			tokens: tokensPayload(seed.tokens),
			cost: seed.cost ?? 0
		}
	});
}

export interface IdleMessageSeed {
	id: string;
	sessionId: string;
	seq: number;
	created: number;
	updated?: number;
	outcome?: string;
}

/** An `idle` message: `{time, outcome}`, never a trigger/step/action (E-13). */
export function addIdleMessage(db: Database, seed: IdleMessageSeed): void {
	addMessage(db, {
		...seed,
		type: 'idle',
		data: { time: { created: seed.created }, outcome: seed.outcome ?? 'idle' }
	});
}

export interface SyntheticMessageSeed {
	id: string;
	sessionId: string;
	seq: number;
	created: number;
	updated?: number;
	text: string;
	/** Optional `{source, childID, agent, state}`; never an edge source (D-6). */
	metadata?: Record<string, unknown>;
}

/** A `synthetic` message: a rendered result, never a delegation edge (D-6). */
export function addSyntheticMessage(db: Database, seed: SyntheticMessageSeed): void {
	addMessage(db, {
		...seed,
		type: 'synthetic',
		data: {
			...(seed.metadata !== undefined ? { metadata: seed.metadata } : {}),
			time: { created: seed.created },
			text: seed.text
		}
	});
}

// ---------------------------------------------------------------------------
// data.content[] item builders
// ---------------------------------------------------------------------------

/** A `data.content[]` item. Fields vary by `type`; kept loose on purpose. */
export interface ContentItem {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	executed?: boolean;
	state?: Record<string, unknown>;
	time?: { created?: number; ran?: number; completed?: number };
	[key: string]: unknown;
}

/** `state.error` is an object in V2 (E-3), never a string. */
export interface ToolErrorSeed {
	type: string;
	message: string;
}

export interface ToolItemOptions {
	/** Provider call id (`item.id`, e.g. `call_function_..._1`); repeats across messages. */
	id: string;
	status: string;
	/** `state.input`; omit to model a call with no input at all. */
	input?: unknown;
	error?: ToolErrorSeed;
	/** One `state.content[].type='text'` output item. */
	text?: string;
	/** One `state.content[].type='file'` output item (base64 payload / URI). */
	file?: { name: string; mime: string; uri: string };
	/** `state.metadata` verbatim (subagent: `{sessionID,status,truncated}`). */
	metadata?: Record<string, unknown>;
	created: number;
	ran?: number;
	completed?: number;
}

/** Build a `type='tool'` item; `name='subagent'` for a delegation (D-5). */
export function toolItem(name: string, options: ToolItemOptions): ContentItem {
	const content: Array<Record<string, unknown>> = [];
	if (options.text !== undefined) content.push({ type: 'text', text: options.text });
	if (options.file !== undefined) content.push({ type: 'file', ...options.file });

	const state: Record<string, unknown> = { status: options.status };
	if (options.input !== undefined) state.input = options.input;
	if (content.length > 0) state.content = content;
	if (options.error !== undefined) {
		state.error = { type: options.error.type, message: options.error.message };
	}
	if (options.metadata !== undefined) state.metadata = { ...options.metadata };

	const time: ContentItem['time'] = { created: options.created };
	if (options.ran !== undefined) time.ran = options.ran;
	if (options.completed !== undefined) time.completed = options.completed;

	return { type: 'tool', id: options.id, name, executed: false, state, time };
}

export interface SubagentItemOptions {
	id: string;
	childSessionId: string | null;
	agent: string;
	description?: string;
	prompt?: string;
	status?: string;
	text?: string;
	/** Optional error for failed delegations (mirrors ToolErrorSeed). */
	error?: ToolErrorSeed;
	created: number;
	ran?: number;
	completed?: number;
}

/**
 * Build a `subagent` delegation tool item (the single edge source, D-5): the
 * child session id lives in `state.metadata.sessionID`, the subagent type in
 * `state.input.agent`.
 */
export function subagentItem(options: SubagentItemOptions): ContentItem {
	return toolItem('subagent', {
		id: options.id,
		status: options.status ?? 'completed',
		input: {
			agent: options.agent,
			...(options.description !== undefined ? { description: options.description } : {}),
			...(options.prompt !== undefined ? { prompt: options.prompt } : {})
		},
		...(options.text !== undefined ? { text: options.text } : {}),
		...(options.error !== undefined ? { error: options.error } : {}),
		metadata: {
			...(options.childSessionId !== null ? { sessionID: options.childSessionId } : {}),
			status: options.status ?? 'completed',
			truncated: false
		},
		created: options.created,
		...(options.ran !== undefined ? { ran: options.ran } : {}),
		...(options.completed !== undefined ? { completed: options.completed } : {})
	});
}

/** One nested Code Mode tool call seed (`state.metadata.toolCalls[]` entry, ADR D-2). */
export interface NestedToolCallSeed {
	tool: string;
	status: string;
	/** `input` object verbatim (e.g. `{ query, namespace }`); omit for a call with no input. */
	input?: unknown;
}

export interface ExecuteItemOptions {
	id: string;
	status?: string;
	/** Nested Code Mode tool calls recorded under `state.metadata.toolCalls`. */
	toolCalls?: NestedToolCallSeed[];
	created: number;
	ran?: number;
	completed?: number;
}

/**
 * Build an `execute` tool item (the Code Mode JS sandbox) with nested MCP tool
 * calls under `state.metadata.toolCalls[]` (ADR D-2). Reuses the `toolItem`
 * shape; the sandbox's own `state.input` (the JS code) is not modelled.
 */
export function executeItem(options: ExecuteItemOptions): ContentItem {
	const metadata: Record<string, unknown> = {};
	if (options.toolCalls !== undefined) metadata.toolCalls = options.toolCalls;
	return toolItem('execute', {
		id: options.id,
		status: options.status ?? 'completed',
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		created: options.created,
		...(options.ran !== undefined ? { ran: options.ran } : {}),
		...(options.completed !== undefined ? { completed: options.completed } : {})
	});
}

/** Build a `type='reasoning'` item with `time.{created,completed}` (spec §3.9). */
export function reasoningItem(text: string, time: { created: number; completed?: number }): ContentItem {
	return {
		type: 'reasoning',
		text,
		state: { reasoningField: 'reasoning_content' },
		time: { created: time.created, ...(time.completed !== undefined ? { completed: time.completed } : {}) }
	};
}

/** Build a `type='text'` item: no time field, by design (spec §3.9/E-6). */
export function textItem(text: string): ContentItem {
	return { type: 'text', text };
}
