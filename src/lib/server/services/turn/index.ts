/**
 * Turn assembler: reconstructs one opencode turn into a {@link GanttModel}
 * (ADR §6.4).
 *
 * A turn = one root-session `role='user'` message + the assistant messages that
 * reference it (`data.parentID`) + the subagent sessions it spawned. All
 * timestamps are wall-clock epoch-ms; `end=null` means "still running"; raw
 * ends in the future or before their start are clamped and flagged.
 *
 * This module is the public surface of the split domain: it orchestrates the
 * scope, node and edge modules and composes the final DTO.
 */
import type { Action, GanttModel, Marker, Node, Step, ToolCall } from '../../../model/types';
import { nodeTrackerRefs, turnTrackerRefs } from '../../../model/tracker';
import {
	getActionParts,
	getCompactionParts,
	getMessages,
	getRemovedMarkers,
	getStepParts,
	getToolParts
} from '../../queries/parts';
import { loadSessionGraph } from '../../queries/session-graph';
import type { DelegationRecord } from '../../schema';
import { buildEdge } from './edge';
import { buildSessionNode } from './node';
import {
	applyScopeFlags,
	computeTurnOfSession,
	selectEdgeRecords,
	selectTurnSessions
} from './scope';
import type { SessionData } from './shared';

export { buildEdge };

/**
 * Reconstruct the turn triggered by `triggerMessageId` of `rootSessionId`.
 * Returns `null` when the root session or the trigger message is unknown.
 */
export function buildTurnModel(
	rootSessionId: string,
	triggerMessageId: string
): GanttModel | null {
	const now = Date.now();
	// One cached query returns the subtree and every delegation edge in it; the
	// root edges are the subset owned by the root session (task #386).
	const { subtree, edges: subtreeEdges } = loadSessionGraph(rootSessionId);
	const rootSession = subtree.find((session) => session.id === rootSessionId);
	if (!rootSession) return null;

	const rootMessages = getMessages(rootSessionId);
	const triggers = rootMessages.filter((message) => message.role === 'user');
	const triggerIndex = triggers.findIndex((message) => message.id === triggerMessageId);
	if (triggerIndex === -1) return null;
	const trigger = triggers[triggerIndex];
	const nextTrigger = triggers[triggerIndex + 1] ?? null;

	const rootEdges = subtreeEdges.filter((edge) => edge.sessionId === rootSessionId);

	// Node -> turn: earliest spawn edge assigns the node (spec R3).
	const turnOfSession = computeTurnOfSession(subtree, rootEdges, triggers);
	const turnSessions = selectTurnSessions(subtree, turnOfSession, triggerIndex);

	const turnMessageIds = new Set(
		rootMessages
			.filter((message) => message.role === 'assistant' && message.parentId === triggerMessageId)
			.map((message) => message.id)
	);
	// The root's part reads are scoped to this turn's messages in SQL, so another
	// turn's parts never reach JS (task #386). Compaction/removed markers stay
	// session-scoped: the assembler intentionally mirrors every compaction and
	// the removed markers are event-sourced, not message-scoped.
	const turnMessageIdList = [...turnMessageIds];

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

	const sessionDataList: SessionData[] = turnSessions.map((session) => {
		const isRoot = session.id === rootSessionId;
		const scope = isRoot ? turnMessageIdList : undefined;
		return {
			session,
			messages: isRoot ? rootMessages : getMessages(session.id),
			stepParts: getStepParts(session.id, scope),
			toolParts: getToolParts(session.id, scope),
			actionParts: getActionParts(session.id, scope),
			compaction: getCompactionParts(session.id),
			removed: getRemovedMarkers(session.id)
		};
	});

	// Edge records: this turn's root edges plus every edge of a subagent node.
	const edgeRecords = selectEdgeRecords(
		rootEdges,
		subtreeEdges,
		sessionDataList,
		rootSessionId,
		triggers,
		triggerIndex,
		turnOfSession,
		countEdge
	);

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
	applyScopeFlags(nodes, edgeRecords, rawEndBySession, nextTrigger, triggers);

	return {
		turnId: `${rootSessionId}_${triggerMessageId}`,
		triggerMessageId,
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
