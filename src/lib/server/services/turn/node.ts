/**
 * Node assembly: build one session's {@link Node} DTO plus the steps, tool
 * calls, markers and actions it owns.
 */
import type { Marker, Node, NodeFlag, NodeStatus, TimeFlag } from '../../../model/types';
import { buildActions } from './actions';
import { buildSteps, linkTools } from './steps';
import { buildToolCalls } from './tool-calls';
import { clampEnd, partsIn, sumUsage, type BuiltNode, type SessionData } from './shared';

export function buildSessionNode(
	sd: SessionData,
	restrict: Set<string> | null,
	startOverride: number | null,
	spawnCount: number,
	subagentType: string | null,
	now: number
): BuiltNode {
	const session = sd.session;
	const messages = restrict ? sd.messages.filter((m) => restrict.has(m.id)) : sd.messages;
	const stepParts = partsIn(sd.stepParts, restrict);
	const toolParts = partsIn(sd.toolParts, restrict);

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
