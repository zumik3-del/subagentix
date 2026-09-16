/**
 * Shared data-transfer objects for the subagentix Gantt (ADR §6.4).
 *
 * This module is imported by both server and client code, so it must stay
 * free of `$lib/server` / DB imports. It describes the reconstructed turn
 * only — never raw SQLite rows.
 */

/** Five token categories plus the derived total and gross cost. */
export interface Usage {
	/** Fresh, uncached input tokens. */
	input: number;
	/** Generated output tokens. Excludes reasoning. */
	output: number;
	/** Thinking tokens. */
	reasoning: number;
	/** Tokens read from the prompt cache. */
	cacheRead: number;
	/** Tokens written to the prompt cache. */
	cacheWrite: number;
	/** `input + output + reasoning + cacheRead + cacheWrite`. */
	total: number;
	/** Gross cost; `0` may mean unmetered, never "missing". */
	cost: number;
}

export type NodeKind = 'orchestrator' | 'subagent';

/** Session lifecycle as far as the data layer can tell. */
export type NodeStatus = 'running' | 'completed' | 'archived' | 'unknown';

/** Raised when a raw end was clamped to `start` (`clampedEnd`) or to now (`futureEnd`). */
export type TimeFlag = 'clampedEnd' | 'futureEnd';

export type NodeFlag = TimeFlag | 'overlapsNextTurn' | 'multiSpawn' | 'orphanEdge';

/** One agent instance = one opencode session. */
export interface Node {
	sessionId: string;
	parentSessionId: string | null;
	agent: string;
	kind: NodeKind;
	modelId: string | null;
	providerId: string | null;
	depth: number;
	directory: string;
	status: NodeStatus;
	/** Wall-clock epoch-ms (clamped when `flags` says so). */
	startedAt: number;
	/** `null` => the node is still running. */
	endedAt: number | null;
	running: boolean;
	flags: NodeFlag[];
	usage: Usage;
	stepCount: number;
	toolCallCount: number;
	errorCount: number;
	compactionCount: number;
	openStep: boolean;
	/**
	 * Tracker references inferred for this node: the deduplicated refs of its
	 * tool calls plus any `task` delegation edge parented to this node. Always
	 * populated by `buildTurnModel`; optional so partial DTO literals stay valid.
	 */
	trackerRefs?: string[];
}

export type EdgeFlag = TimeFlag | 'noChild';

/** One delegation = one `tool='task'` part. */
export interface Edge {
	id: string;
	/** Parent node (caller) session id. */
	parentNodeId: string;
	/** Child session id; `null` for a spawn that failed before a session existed. */
	childNodeId: string | null;
	subagentType: string | null;
	status: string;
	error: string | null;
	startedAt: number | null;
	/** `null` => the spawn is still running. */
	endedAt: number | null;
	running: boolean;
	flags: EdgeFlag[];
	resultBytes: number;
	description: string | null;
	trackerRefs: string[];
}

export type StepFlag = TimeFlag;

/** One LLM provider call = one `step-start` … `step-finish` pair. */
export interface Step {
	id: string;
	nodeId: string;
	messageId: string;
	/** Order within the message, 0-based. */
	index: number;
	startedAt: number;
	/** `null` => open step (no `step-finish` yet). */
	endedAt: number | null;
	open: boolean;
	flags: StepFlag[];
	reason: string | null;
	usage: Usage;
	modelId: string | null;
	hasCompaction: boolean;
	toolCallIds: string[];
}

/** One tool / MCP invocation. */
export interface ToolCall {
	id: string;
	nodeId: string;
	/** Owning step, or `null` when it could not be attributed. */
	stepId: string | null;
	callId: string | null;
	name: string;
	status: string;
	error: string | null;
	startedAt: number | null;
	/** `null` => still running. */
	endedAt: number | null;
	flags: TimeFlag[];
	/** Raw JSON text as stored; the UI truncates. */
	input: string | null;
	/** Raw text as stored; the UI truncates. */
	output: string | null;
	isMcp: boolean;
	isDelegation: boolean;
	trackerRefs: string[];
	/**
	 * The permission prompt this call triggered (matched by session + call id),
	 * or `null`/absent when the collector saw none. Additive; always populated
	 * by the turn assembler when the permission store has a match.
	 */
	permission?: PermissionInfo | null;
}

/**
 * Every non-tool action a node produced, surfaced in the drill-down Actions
 * timeline. Tool calls and LLM steps keep their own DTOs; this union covers the
 * remaining `part.data.type` values the panel used to hide.
 */
export type ActionKind = 'text' | 'reasoning' | 'patch' | 'file' | 'agent' | 'compaction';

/**
 * One non-tool action of a node. `at` is the part start (or row creation) in
 * epoch-ms; `endedAt` is only set for parts that carry `time.end`
 * (text/reasoning). `summary` is the display excerpt — the UI truncates.
 */
export interface Action {
	id: string;
	nodeId: string;
	kind: ActionKind;
	at: number;
	endedAt: number | null;
	/** Short label: `patch`, a filename, an agent mention, or the kind itself. */
	label: string;
	/** Excerpt / file list / mime / source, depending on `kind`. */
	summary: string;
	/**
	 * Role of the owning message (`user`/`assistant`) when known, so the UI can
	 * mark a user message's `text` as the prompt. Optional for partial DTOs.
	 */
	role?: string | null;
}

/**
 * A user permission prompt that an action triggered, reconstructed from the
 * opencode event stream (never persisted by opencode itself). `reply` is
 * `null` while the request is still pending.
 */
export interface PermissionInfo {
	requestId: string;
	permission: string;
	patterns: string[];
	reply: 'once' | 'always' | 'reject' | null;
	askedAt: number;
	repliedAt: number | null;
}

export type MarkerType = 'compaction' | 'removed';

/**
 * A point-in-time marker. `at` is epoch-ms when the DB carries a timestamp;
 * `message.removed` events carry only ids, so their marker has `at === null`.
 */
export interface Marker {
	type: MarkerType;
	nodeId: string;
	at: number | null;
}

/**
 * Lightweight turn payload (Phase 4 / task #387): the node/edge skeleton plus
 * the turn metadata needed to draw the Gantt rows, bars and delegation edges.
 *
 * The heavy per-node detail (`steps`/`toolCalls`/`markers`/`actions`) is omitted
 * from the streamed payload and fetched lazily per selected node as a
 * {@link NodeDetail} from `/api/sessions/[id]/nodes/[nodeId]`. The four arrays
 * stay optional so a full {@link GanttModel} (and partial test literals) remains
 * assignable to it.
 */
export interface GanttOutline {
	turnId: string;
	rootSessionId: string;
	agent: string;
	/** Turn window start (trigger message), epoch-ms. */
	t0: number;
	/** Turn window end (raw, un-clamped max node end), epoch-ms. */
	t1: number;
	nodes: Node[];
	edges: Edge[];
	/**
	 * Every tracker reference inferred in the turn, deduplicated in first-seen
	 * order. Populated by `buildTurnModel`; optional so partial DTO literals
	 * (tests, incremental construction) stay valid.
	 */
	trackerRefs?: string[];
	/**
	 * Trigger message id of the turn (the `?turn=` value): lets the client fetch
	 * one node's detail without a turn re-scan. Set by the outline builder only.
	 */
	triggerMessageId?: string;
	/**
	 * Non-tool actions (text, reasoning, patches, files, agent mentions,
	 * compaction) for the unified drill-down timeline. Populated by
	 * `buildTurnModel`; omitted from the streamed outline.
	 */
	actions?: Action[];
	/** LLM steps of the turn; omitted from the streamed outline (Phase 4). */
	steps?: Step[];
	/** Tool / MCP calls of the turn; omitted from the streamed outline. */
	toolCalls?: ToolCall[];
	/** Compaction / removed markers; omitted from the streamed outline. */
	markers?: Marker[];
}

/** The full reconstructed turn, ready for the SVG Gantt. */
export interface GanttModel extends GanttOutline {
	steps: Step[];
	toolCalls: ToolCall[];
	markers: Marker[];
	/**
	 * Non-tool actions (text, reasoning, patches, files, agent mentions,
	 * compaction) for the unified drill-down timeline. Populated by
	 * `buildTurnModel`; optional so partial DTO literals stay valid.
	 */
	actions?: Action[];
}

/**
 * One node of a turn plus everything it owns, for the drill-down panel and the
 * `/api/sessions/[id]/nodes/[nodeId]` payload (M3c). Server-free DTO.
 */
export interface NodeDetail {
	node: Node;
	steps: Step[];
	toolCalls: ToolCall[];
	markers: Marker[];
	/** Non-tool actions for the unified timeline (always set by the builders). */
	actions?: Action[];
}

/**
 * One directory of the session sidebar: a root-session `session.directory`
 * group (task #212). `updatedAt` is the newest root-session `time_updated` in
 * the group, used to order the tree newest-first.
 */
export interface DirectorySummary {
	/** Absolute directory path shared by the grouped root sessions. */
	directory: string;
	/**
	 * opencode project name for the directory (`project.name`), or `null` when
	 * the schema has no project linkage or the project has no usable name. The
	 * sidebar prefers it over the raw path.
	 */
	projectName: string | null;
	/** Number of root sessions in this directory (drives the tree count + paging). */
	sessionCount: number;
	/** Newest `session.time_updated` in the group, epoch-ms. */
	updatedAt: number;
}

/** One row of the session list (`/`). */
export interface SessionSummary {
	id: string;
	title: string;
	agent: string;
	directory: string;
	createdAt: number;
	updatedAt: number;
	usage: Usage;
	/** Number of direct child sessions. */
	childCount: number;
}

/** One selectable turn of a root session (session header, `/sessions/[id]`). */
export interface TurnSummary {
	/** Root user message id — the turn's trigger and stable turn id. */
	turnId: string;
	/** 1-based order within the session by trigger `time_created`. */
	index: number;
	/** Trigger message `time_created`, epoch-ms. */
	startedAt: number;
	/** Assistant messages that reference this trigger. */
	assistantCount: number;
}

/**
 * A bounded, selection-aware window over a session's turn list (M4b). The page
 * renders `turns` only; the counters let the UI show an honest range and
 * enabled/disabled older/newer controls without another query. `size` is the
 * requested page size; `turns` may be up to `2 × size` long when an
 * authoritative `turnStart` page is grown to keep the selected turn visible.
 */
export interface TurnWindow {
	/** The rendered slice, ascending by turn index. */
	turns: TurnSummary[];
	/** Total turns in the session. */
	total: number;
	/** 0-based index of the first rendered turn. */
	start: number;
	/** 0-based exclusive end index (`start + turns.length`). */
	end: number;
	/** Requested page size (`>= 1`); `turns.length` may reach `2 × size`. */
	size: number;
	/** Turns hidden before the window (`= start`). */
	hiddenOlder: number;
	/** Turns hidden after the window (`= total - end`). */
	hiddenNewer: number;
	/** `true` when older turns exist before the window. */
	hasOlder: boolean;
	/** `true` when newer turns exist after the window. */
	hasNewer: boolean;
}

/** One descendant session of a root, as listed on `/sessions/[id]`. */
export interface ChildSession {
	id: string;
	parentId: string | null;
	title: string;
	agent: string;
	directory: string;
	/** Depth relative to the root (root = 0, direct child = 1, …). */
	depth: number;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
	usage: Usage;
}

/** `GET /api/sessions/[id]` payload: session header + subtree edges + turns. */
export interface SessionDetail {
	/** Summary of the requested root session. */
	session: SessionSummary;
	/** Every descendant session in the root's subtree. */
	children: ChildSession[];
	/** Delegation edges found across the subtree. */
	edges: Edge[];
	/** Root-session turns, ordered by trigger time. */
	turns: TurnSummary[];
}
