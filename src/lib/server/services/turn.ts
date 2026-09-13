/**
 * Turn assembler: reconstructs one opencode turn into a {@link GanttModel}
 * (ADR §6.4).
 *
 * A turn = one root-session `role='user'` message + the assistant messages that
 * reference it (`data.parentID`) + the subagent sessions it spawned. All
 * timestamps are wall-clock epoch-ms; `end=null` means "still running"; raw
 * ends in the future or before their start are clamped and flagged.
 *
 * This is the only module with domain logic; it composes the query layer and
 * never touches SQLite directly.
 */
import { addUsage, emptyUsage, usageFromCounts } from '../../model/token';
import { nodeTrackerRefs, turnTrackerRefs } from '../../model/tracker';
import type {
	Action,
	ActionKind,
	Edge,
	EdgeFlag,
	GanttModel,
	Marker,
	Node,
	NodeFlag,
	NodeStatus,
	PermissionInfo,
	Step,
	StepFlag,
	TimeFlag,
	ToolCall,
	Usage
} from '../../model/types';
import {
	getDelegationEdges,
	getSessionSubtree,
	type SessionSubtreeRecord
} from '../queries/sessions';
import {
	getActionParts,
	getCompactionParts,
	getMessages,
	getRemovedMarkers,
	getStepParts,
	getToolParts
} from '../queries/parts';
import {
	PART_TYPE,
	type DelegationRecord,
	type MessageRecord,
	type PartRecord,
	type RemovedMarkerRecord
} from '../schema';
import { lookupPermission } from '../permission-store';

/** Tools that ship with opencode; everything with `_` and not here is MCP. */
const BUILTIN_TOOLS = new Set([
	'bash',
	'read',
	'edit',
	'grep',
	'glob',
	'write',
	'webfetch',
	'todowrite',
	'task',
	'question',
	'skill',
	'invalid'
]);

interface SessionData {
	session: SessionSubtreeRecord;
	messages: MessageRecord[];
	stepParts: PartRecord[];
	toolParts: PartRecord[];
	actionParts: PartRecord[];
	compaction: PartRecord[];
	removed: RemovedMarkerRecord[];
}

interface BuiltNode {
	node: Node;
	/** Raw (un-clamped) end, used for the turn's `t1` and overlap flags. */
	rawEnd: number | null;
	steps: Step[];
	toolCalls: ToolCall[];
	markers: Marker[];
	actions: Action[];
}

function isMcpTool(name: string): boolean {
	return name.includes('_') && !BUILTIN_TOOLS.has(name);
}

/** The `part` text fields a tracker reference can be inferred from. */
interface TrackerTexts {
	/** `state.input` JSON text. */
	input: string | null;
	/** `state.output` JSON text. */
	output: string | null;
	/** `state.input.prompt`. */
	prompt: string | null;
	/** `state.input.description`. */
	description: string | null;
}

/** Read the first present, non-empty JSON key from a `state.*` text blob. */
function jsonTrackerId(text: string | null, keys: readonly string[]): string | null {
	if (!text) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object') return null;
		const record = parsed as Record<string, unknown>;
		for (const key of keys) {
			const value = record[key];
			if (value === undefined || value === null) continue;
			const id = String(value).trim();
			if (id !== '') return id;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Infer tracker references for one tool call (spec §6 "ziptask link"), in a
 * fixed order:
 * 1. `ziptask_*` calls read `state.input.task_id` / `state.input.id`, else parse
 *    `state.output.id`.
 * 2. `task` calls match `Task #(\d+)` in `state.input.prompt` / `description`.
 *
 * Deduplicated in first-seen order and always inferred — never authoritative.
 */
function extractTrackerRefs(name: string, texts: TrackerTexts): string[] {
	if (name.startsWith('ziptask_')) {
		const inputId = jsonTrackerId(texts.input, ['task_id', 'id']);
		if (inputId !== null) return [inputId];
		const outputId = jsonTrackerId(texts.output, ['id']);
		return outputId === null ? [] : [outputId];
	}
	if (name === 'task') {
		const refs = new Set<string>();
		for (const text of [texts.prompt, texts.description]) {
			if (!text) continue;
			for (const match of text.matchAll(/Task #(\d+)/g)) refs.add(match[1]);
		}
		return [...refs];
	}
	return [];
}

function subtractUsage(message: Usage, closed: Usage): Usage {
	const sub = (a: number, b: number) => Math.max(0, a - b);
	return usageFromCounts(
		{
			input: sub(message.input, closed.input),
			output: sub(message.output, closed.output),
			reasoning: sub(message.reasoning, closed.reasoning),
			cacheRead: sub(message.cacheRead, closed.cacheRead),
			cacheWrite: sub(message.cacheWrite, closed.cacheWrite)
		},
		sub(message.cost, closed.cost)
	);
}

function sumUsage(usages: Usage[]): Usage {
	return usages.reduce(addUsage, emptyUsage());
}

function hasCompactionBetween(times: number[], start: number, end: number): boolean {
	return times.some((time) => time >= start && time <= end);
}

function clampEnd(
	startedAt: number,
	rawEnd: number | null,
	now: number
): { endedAt: number | null; flags: TimeFlag[] } {
	if (rawEnd === null) return { endedAt: null, flags: [] };
	let endedAt = rawEnd;
	const flags: TimeFlag[] = [];
	if (endedAt > now) {
		endedAt = now;
		flags.push('futureEnd');
	}
	if (endedAt < startedAt) {
		endedAt = startedAt;
		flags.push('clampedEnd');
	}
	return { endedAt, flags };
}

/** Pair `step-start`/`step-finish` parts into steps (spec §3.1). */
function buildSteps(
	sd: SessionData,
	restrict: Set<string> | null,
	compactionTimes: number[],
	now: number
): Step[] {
	const messagesById = new Map(sd.messages.map((message) => [message.id, message]));
	const grouped = new Map<string, PartRecord[]>();
	for (const part of sd.stepParts) {
		if (restrict && !restrict.has(part.messageId)) continue;
		const list = grouped.get(part.messageId);
		if (list) list.push(part);
		else grouped.set(part.messageId, [part]);
	}

	const steps: Step[] = [];
	for (const [messageId, parts] of grouped) {
		const message = messagesById.get(messageId);
		let openStart: PartRecord | null = null;
		let index = 0;
		let closedUsage = emptyUsage();

		for (const part of parts) {
			if (part.type === PART_TYPE.stepStart) {
				openStart = part;
				continue;
			}
			if (part.type !== PART_TYPE.stepFinish) continue;

			const startedAt = openStart?.createdAt ?? part.createdAt;
			const { endedAt, flags } = clampEnd(startedAt, part.createdAt, now);
			const step: Step = {
				id: part.id,
				nodeId: part.sessionId,
				messageId,
				index: index++,
				startedAt,
				endedAt,
				open: false,
				flags: flags as StepFlag[],
				reason: part.reason,
				usage: usageFromCounts(part.usage, part.cost),
				modelId: message?.modelId ?? null,
				hasCompaction:
					endedAt !== null && hasCompactionBetween(compactionTimes, startedAt, endedAt),
				toolCallIds: []
			};
			steps.push(step);
			closedUsage = addUsage(closedUsage, step.usage);
			openStart = null;
		}

		if (openStart) {
			// Open step (no `step-finish`): residual usage = message tokens - closed steps.
			const messageUsage = message ? usageFromCounts(message.usage, message.cost) : emptyUsage();
			steps.push({
				id: openStart.id,
				nodeId: openStart.sessionId,
				messageId,
				index: index++,
				startedAt: openStart.createdAt,
				endedAt: null,
				open: true,
				flags: [],
				reason: null,
				usage: subtractUsage(messageUsage, closedUsage),
				modelId: message?.modelId ?? sd.session.modelId,
				hasCompaction: false,
				toolCallIds: []
			});
		}
	}
	return steps;
}

function mapToolCall(part: PartRecord, nodeId: string, now: number): ToolCall {
	const startedAt = part.stateStart;
	const { endedAt, flags } = clampEnd(startedAt ?? now, part.stateEnd, now);
	const name = part.tool ?? 'unknown';
	return {
		id: part.id,
		nodeId,
		stepId: null,
		callId: part.callId,
		name,
		status: part.status ?? 'unknown',
		error: part.error,
		startedAt,
		endedAt,
		flags: flags as TimeFlag[],
		input: part.input,
		output: part.output,
		isMcp: isMcpTool(name),
		isDelegation: name === 'task',
		trackerRefs: extractTrackerRefs(name, {
			input: part.input,
			output: part.output,
			prompt: part.prompt,
			description: part.description
		})
	};
}

function buildToolCalls(sd: SessionData, restrict: Set<string> | null, now: number): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const part of sd.toolParts) {
		if (restrict && !restrict.has(part.messageId)) continue;
		calls.push(mapToolCall(part, sd.session.id, now));
	}
	return calls;
}

/** Parse a `patch.files` JSON array into a comma-joined summary (tolerant). */
function patchFilesSummary(files: string | null): string {
	if (!files) return '';
	try {
		const parsed: unknown = JSON.parse(files);
		if (!Array.isArray(parsed)) return files;
		return parsed.map((value) => String(value)).join(', ');
	} catch {
		return files;
	}
}

/** Map one non-tool part to a timeline {@link Action}. */
function mapAction(
	part: PartRecord,
	kind: ActionKind,
	nodeId: string,
	role: string | null
): Action {
	const at = part.partStart ?? part.createdAt;
	switch (kind) {
		case 'text':
		case 'reasoning':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: part.partEnd,
				label: kind,
				summary: part.text ?? '',
				role
			};
		case 'patch':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: null,
				label: 'patch',
				summary: patchFilesSummary(part.files),
				role
			};
		case 'file':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: null,
				label: part.filename ?? 'file',
				summary: part.mime ?? '',
				role
			};
		case 'agent':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: null,
				label: part.agentName ?? 'agent',
				summary: '',
				role
			};
		case 'compaction':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: null,
				label: 'compaction',
				summary: '',
				role: null
			};
	}
}

function buildActions(sd: SessionData, restrict: Set<string> | null): Action[] {
	const actions: Action[] = [];
	const roleByMessage = new Map(sd.messages.map((message) => [message.id, message.role]));
	for (const part of sd.actionParts) {
		if (restrict && !restrict.has(part.messageId)) continue;
		const kind = part.type as ActionKind;
		if (kind === 'text' || kind === 'reasoning' || kind === 'patch' || kind === 'file' || kind === 'agent') {
			actions.push(mapAction(part, kind, sd.session.id, roleByMessage.get(part.messageId) ?? null));
		}
	}
	// Compaction mirrors the marker list: already time-filtered for the root,
	// never message-restricted.
	for (const part of sd.compaction) {
		actions.push(mapAction(part, 'compaction', sd.session.id, null));
	}
	return actions;
}

/**
 * Attribute each tool call to the step that requested it: the latest closed
 * step in the same message whose end precedes the call. Falls back to the last
 * step of the message, else leaves `stepId` null.
 */
function linkTools(
	stepsWithMessage: Array<{ step: Step; messageId: string }>,
	calls: ToolCall[],
	callMessage: Map<string, string>
): void {
	const byMessage = new Map<string, Step[]>();
	for (const { step, messageId } of stepsWithMessage) {
		const list = byMessage.get(messageId);
		if (list) list.push(step);
		else byMessage.set(messageId, [step]);
	}
	for (const call of calls) {
		const messageId = callMessage.get(call.id);
		if (!messageId) continue;
		const candidates = byMessage.get(messageId) ?? [];
		if (candidates.length === 0) continue;
		const startedAt = call.startedAt ?? Number.POSITIVE_INFINITY;
		let best: Step | null = null;
		for (const candidate of candidates) {
			if (candidate.endedAt !== null && candidate.endedAt <= startedAt) best = candidate;
		}
		best ??= candidates[candidates.length - 1];
		call.stepId = best.id;
		best.toolCallIds.push(call.id);
	}
}

function buildSessionNode(
	sd: SessionData,
	restrict: Set<string> | null,
	startOverride: number | null,
	spawnCount: number,
	subagentType: string | null,
	now: number
): BuiltNode {
	const session = sd.session;
	const messages = restrict ? sd.messages.filter((m) => restrict.has(m.id)) : sd.messages;
	const stepParts = restrict ? sd.stepParts.filter((p) => restrict.has(p.messageId)) : sd.stepParts;
	const toolParts = restrict ? sd.toolParts.filter((p) => restrict.has(p.messageId)) : sd.toolParts;

	const startCandidates = [
		...(restrict ? [] : [session.createdAt]),
		...messages.map((m) => m.startedAt),
		...stepParts.map((p) => p.createdAt),
		...toolParts.map((p) => p.createdAt)
	];
	const startedAt = startOverride ?? (startCandidates.length ? Math.min(...startCandidates) : session.createdAt);

	const endCandidates = [
		...(restrict ? [] : [session.updatedAt]),
		...messages.map((m) => m.completedAt ?? m.updatedAt),
		...stepParts.map((p) => p.updatedAt),
		...toolParts.map((p) => p.updatedAt)
	];
	const rawEnd = endCandidates.length ? Math.max(...endCandidates) : startedAt;

	const running =
		messages.some((m) => m.role === 'assistant' && m.completedAt === null) ||
		toolParts.some((p) => p.status === 'running');

	const compaction = restrict
		? sd.compaction.filter((p) => p.createdAt >= startedAt && p.createdAt <= rawEnd)
		: sd.compaction;
	const compactionTimes = compaction.map((p) => p.createdAt);

	const steps = buildSteps(sd, restrict, compactionTimes, now);
	const actions = buildActions(sd, restrict);
	const callMessage = new Map<string, string>();
	const allCalls = buildToolCalls(sd, restrict, now);
	for (const part of toolParts) callMessage.set(part.id, part.messageId);
	for (const call of allCalls) call.permission = lookupPermission(call.nodeId, call.callId);
	linkTools(
		steps.map((step) => ({ step, messageId: step.messageId })),
		allCalls,
		callMessage
	);

	const usage = sumUsage(steps.map((step) => step.usage));
	const flags: NodeFlag[] = [];
	if (spawnCount > 1) flags.push('multiSpawn');
	const clamped = running ? { endedAt: null, flags: [] as TimeFlag[] } : clampEnd(startedAt, rawEnd, now);
	flags.push(...clamped.flags);

	const status: NodeStatus = running
		? 'running'
		: session.archivedAt !== null
			? 'archived'
			: 'completed';

	const node: Node = {
		sessionId: session.id,
		parentSessionId: session.parentId,
		agent: session.agent ?? subagentType ?? 'unknown',
		kind: session.depth === 0 ? 'orchestrator' : 'subagent',
		modelId: session.modelId,
		providerId: session.providerId,
		depth: session.depth,
		directory: session.directory,
		status,
		startedAt,
		endedAt: clamped.endedAt,
		running,
		flags,
		usage,
		stepCount: steps.length,
		toolCallCount: allCalls.length,
		errorCount: allCalls.filter((call) => call.status === 'error').length,
		compactionCount: compaction.length,
		openStep: steps.some((step) => step.open)
	};

	const markers: Marker[] = [
		...compaction.map((part): Marker => ({ type: 'compaction', nodeId: session.id, at: part.createdAt })),
		...sd.removed.map((): Marker => ({ type: 'removed', nodeId: session.id, at: null }))
	];

	return { node, rawEnd, steps, toolCalls: allCalls, markers, actions };
}

function edgeSortTime(edge: DelegationRecord): number {
	return edge.startedAt ?? edge.createdAt;
}

/** Index of the trigger whose half-open window contains `time` (ties -> later). */
function turnIndexOf(time: number, triggers: MessageRecord[]): number {
	let index = 0;
	for (let i = 0; i < triggers.length; i++) {
		if (time >= triggers[i].startedAt) index = i;
		else break;
	}
	return index;
}

/**
 * Map one delegation record to the shared `Edge` DTO. Exported so the session
 * detail service and the Gantt agree on the edge shape.
 */
export function buildEdge(record: DelegationRecord, now: number): Edge {
	const startedAt = record.startedAt ?? record.createdAt;
	const running = record.status === 'running' || record.endedAt === null;
	const { endedAt, flags: clampFlags } = clampEnd(startedAt, record.endedAt, now);
	const flags: EdgeFlag[] = [...clampFlags];
	if (record.childSessionId === null) flags.push('noChild');
	return {
		id: record.id,
		parentNodeId: record.parentSessionId ?? record.sessionId,
		childNodeId: record.childSessionId,
		subagentType: record.subagentType,
		status: record.status,
		error: record.error,
		startedAt,
		endedAt: running ? null : endedAt,
		running,
		flags,
		resultBytes: record.resultBytes,
		description: record.description,
		trackerRefs: extractTrackerRefs('task', {
			input: null,
			output: null,
			prompt: record.prompt,
			description: record.description
		})
	};
}

/**
 * Reconstruct the turn triggered by `triggerMessageId` of `rootSessionId`.
 * Returns `null` when the root session or the trigger message is unknown.
 */
export function buildTurnModel(
	rootSessionId: string,
	triggerMessageId: string
): GanttModel | null {
	const now = Date.now();
	const subtree = getSessionSubtree(rootSessionId);
	const rootSession = subtree.find((session) => session.id === rootSessionId);
	if (!rootSession) return null;

	const rootMessages = getMessages(rootSessionId);
	const triggers = rootMessages.filter((message) => message.role === 'user');
	const triggerIndex = triggers.findIndex((message) => message.id === triggerMessageId);
	if (triggerIndex === -1) return null;
	const trigger = triggers[triggerIndex];
	const nextTrigger = triggers[triggerIndex + 1] ?? null;

	const rootEdges = getDelegationEdges(rootSessionId);

	// Node -> turn: earliest spawn edge assigns the node (spec R3).
	const turnOfSession = new Map<string, number>();
	for (const session of subtree) {
		if (session.depth !== 1) continue;
		const edges = rootEdges.filter((edge) => edge.childSessionId === session.id);
		if (edges.length === 0) continue;
		const earliest = edges.reduce((a, b) => (edgeSortTime(a) <= edgeSortTime(b) ? a : b));
		turnOfSession.set(session.id, turnIndexOf(edgeSortTime(earliest), triggers));
	}

	const parentById = new Map(subtree.map((session) => [session.id, session.parentId]));
	const depthById = new Map(subtree.map((session) => [session.id, session.depth]));
	const topLevelAncestor = (sessionId: string): string => {
		let current = sessionId;
		while ((depthById.get(current) ?? 0) > 1) {
			const parent = parentById.get(current);
			if (!parent) break;
			current = parent;
		}
		return current;
	};

	const turnSessions = subtree.filter(
		(session) =>
			session.depth === 0 || turnOfSession.get(topLevelAncestor(session.id)) === triggerIndex
	);

	const turnMessageIds = new Set(
		rootMessages
			.filter((message) => message.role === 'assistant' && message.parentId === triggerMessageId)
			.map((message) => message.id)
	);

	// Spawn counts / fallback agent names across every edge in the turn.
	const spawnCounts = new Map<string, number>();
	const subagentTypeByChild = new Map<string, string>();
	const countEdge = (edge: DelegationRecord) => {
		if (edge.childSessionId === null) return;
		spawnCounts.set(edge.childSessionId, (spawnCounts.get(edge.childSessionId) ?? 0) + 1);
		if (edge.subagentType && !subagentTypeByChild.has(edge.childSessionId)) {
			subagentTypeByChild.set(edge.childSessionId, edge.subagentType);
		}
	};
	for (const edge of rootEdges) countEdge(edge);

	const sessionDataList: SessionData[] = turnSessions.map((session) => ({
		session,
		messages: session.id === rootSessionId ? rootMessages : getMessages(session.id),
		stepParts: getStepParts(session.id),
		toolParts: getToolParts(session.id),
		actionParts: getActionParts(session.id),
		compaction: getCompactionParts(session.id),
		removed: getRemovedMarkers(session.id)
	}));

	// Edge records: this turn's root edges plus every edge of a subagent node.
	const edgeRecords = new Map<string, DelegationRecord>();
	for (const edge of rootEdges) {
		const inWindow = turnIndexOf(edgeSortTime(edge), triggers) === triggerIndex;
		const childInTurn =
			edge.childSessionId !== null && turnOfSession.get(edge.childSessionId) === triggerIndex;
		if (inWindow || childInTurn) edgeRecords.set(edge.id, edge);
	}
	for (const data of sessionDataList) {
		if (data.session.id === rootSessionId) continue;
		for (const edge of getDelegationEdges(data.session.id)) {
			edgeRecords.set(edge.id, edge);
			countEdge(edge);
		}
	}

	const nodes: Node[] = [];
	const steps: Step[] = [];
	const toolCalls: ToolCall[] = [];
	const markers: Marker[] = [];
	const actions: Action[] = [];
	const rawEndBySession = new Map<string, number | null>();
	let t1 = trigger.startedAt;

	for (const data of sessionDataList) {
		const restrict = data.session.id === rootSessionId ? turnMessageIds : null;
		const startOverride = data.session.id === rootSessionId ? trigger.startedAt : null;
		const built = buildSessionNode(
			data,
			restrict,
			startOverride,
			spawnCounts.get(data.session.id) ?? 0,
			subagentTypeByChild.get(data.session.id) ?? null,
			now
		);
		nodes.push(built.node);
		steps.push(...built.steps);
		toolCalls.push(...built.toolCalls);
		markers.push(...built.markers);
		actions.push(...built.actions);
		rawEndBySession.set(data.session.id, built.rawEnd);
		if (built.rawEnd !== null) t1 = Math.max(t1, built.rawEnd);
		if (built.node.running) t1 = Math.max(t1, now);
	}

	const edges = [...edgeRecords.values()].map((record) => buildEdge(record, now));

	// Inferred tracker refs (M4): per node (its tool calls plus the `task` edges
	// it spawned) and the whole turn (their union), deduplicated. Additive,
	// client-safe DTO fields; never authoritative.
	for (const node of nodes) {
		node.trackerRefs = nodeTrackerRefs(node, toolCalls, edges);
	}
	const trackerRefs = turnTrackerRefs({ nodes, toolCalls, edges });

	// Overlap and orphan flags after the raw spans are known.
	if (nextTrigger) {
		for (const node of nodes) {
			const rawEnd = rawEndBySession.get(node.sessionId);
			if (rawEnd !== null && rawEnd !== undefined && rawEnd > nextTrigger.startedAt) {
				node.flags.push('overlapsNextTurn');
			}
		}
	}
	for (const edge of edgeRecords.values()) {
		if (edgeSortTime(edge) < triggers[0].startedAt) {
			const parentId = edge.parentSessionId ?? edge.sessionId;
			const parent = nodes.find((node) => node.sessionId === parentId);
			if (parent && !parent.flags.includes('orphanEdge')) parent.flags.push('orphanEdge');
		}
	}

	return {
		turnId: `${rootSessionId}_${triggerMessageId}`,
		rootSessionId,
		agent: rootSession.agent ?? 'unknown',
		t0: trigger.startedAt,
		t1,
		nodes,
		edges,
		steps,
		toolCalls,
		markers,
		actions,
		trackerRefs
	};
}
