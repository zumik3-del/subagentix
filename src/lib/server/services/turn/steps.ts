/**
 * Step assembly: pair `step-start`/`step-finish` parts into {@link Step} DTOs
 * and attribute tool calls to the step that requested them.
 */
import { addUsage, emptyUsage, usageFromCounts } from '../../../model/token';
import type { Step, ToolCall } from '../../../model/types';
import { PART_TYPE, type PartRecord } from '../../schema';
import { clampEnd, hasCompactionBetween, partsIn, subtractUsage, type SessionData } from './shared';

/** Pair `step-start`/`step-finish` parts into steps (spec §3.1). */
export function buildSteps(
	sd: SessionData,
	restrict: Set<string> | null,
	compactionTimes: number[],
	now: number
): Step[] {
	const messagesById = new Map(sd.messages.map((message) => [message.id, message]));
	const grouped = new Map<string, PartRecord[]>();
	for (const part of partsIn(sd.stepParts, restrict)) {
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
				flags,
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

/**
 * Attribute each tool call to the step that requested it: the latest closed
 * step in the same message whose end precedes the call. Falls back to the last
 * step of the message, else leaves `stepId` null.
 */
export function linkTools(
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
