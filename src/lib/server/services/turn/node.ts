/**
 * Node assembly: build one session's {@link Node} DTO plus the steps, tool
 * calls, markers and actions it owns.
 */
import type { Marker, Node, NodeFlag, NodeStatus, TimeFlag } from '../../../model/types';
import { isFailedToolStatus } from '../../../model/tool-kind';
import { MESSAGE_TYPE } from '../../schema';
import { UNKNOWN_LABEL } from '../../queries/dashboard-shared';
import { buildActions } from './actions';
import { buildSteps, linkTools } from './steps';
import { buildToolCalls } from './tool-calls';
import { clampEnd, itemsIn, messagesIn, sumUsage, type BuiltNode, type SessionData } from './shared';

export function buildSessionNode(
	sd: SessionData,
	restrict: Set<string> | null,
	startOverride: number | null,
	spawnCount: number,
	subagentType: string | null,
	now: number,
	turnWindow?: { start: number; end: number }
): BuiltNode {
	const session = sd.session;
	const messages = messagesIn(sd.messages, restrict);
	const toolItems = itemsIn(sd.toolItems, restrict);
	const actionItems = itemsIn(sd.actionItems, restrict);

	// Start/end candidates come from the messages and the content-item times
	// (spec §P2): a message's row-level `updatedAt` is the V2 fallback for an
	// assistant message with no `time.completed`.
	const messageStarts = messages.map((m) => m.startedAt);
	const itemStarts = [...toolItems, ...actionItems]
		.map((item) => item.timeRan ?? item.timeCreated)
		.filter((time): time is number => time !== null);
	const startCandidates = [
		...(restrict ? [] : [session.createdAt]),
		...messageStarts,
		...itemStarts
	];
	const startedAt = startOverride ?? (startCandidates.length ? Math.min(...startCandidates) : session.createdAt);

	const messageEnds = messages.map((m) => m.completedAt ?? m.updatedAt);
	const itemEnds = [...toolItems, ...actionItems]
		.map((item) => item.timeCompleted)
		.filter((time): time is number => time !== null);
	const endCandidates = [
		...(restrict ? [] : [session.updatedAt]),
		...messageEnds,
		...itemEnds
	];
	const rawEnd = endCandidates.length ? Math.max(...endCandidates) : startedAt;

	const running =
		messages.some((m) => m.role === MESSAGE_TYPE.assistant && m.completedAt === null) ||
		toolItems.some((item) => item.status === 'running');

	const compactionTimes = sd.compactions
		.map((item) => item.timeCreated)
		.filter((time): time is number => time !== null);
	const compaction = restrict
		? sd.compactions.filter(
				(item) =>
					item.timeCreated !== null &&
					item.timeCreated >= startedAt &&
					item.timeCreated <= rawEnd
			)
		: sd.compactions;

	const steps = buildSteps(sd, restrict, compactionTimes, now);
	const actions = buildActions(sd, restrict, turnWindow);
	const callMessage = new Map<string, string>();
	const allCalls = buildToolCalls(sd, restrict, now);
	for (const item of toolItems) callMessage.set(item.id, item.messageId);
	// Nested calls (parentCallId set) inherit the parent's message attribution.
	for (const call of allCalls) {
		if (call.parentCallId !== undefined) {
			const messageId = callMessage.get(call.parentCallId);
			if (messageId !== undefined) callMessage.set(call.id, messageId);
		}
	}
	linkTools(steps, allCalls, callMessage);

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
		agent: session.agent ?? subagentType ?? UNKNOWN_LABEL,
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
		errorCount: allCalls.filter((call) => isFailedToolStatus(call.status)).length,
		compactionCount: compaction.length,
		openStep: steps.some((step) => step.open)
	};

	const markers: Marker[] = compaction.map(
		(item): Marker => ({ type: 'compaction', nodeId: session.id, at: item.timeCreated })
	);

	return { node, rawEnd, steps, toolCalls: allCalls, markers, actions };
}
