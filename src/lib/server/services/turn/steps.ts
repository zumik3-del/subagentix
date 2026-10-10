/**
 * Step assembly: one `assistant` message = one {@link Step} (decision D-1,
 * spec §3.1). Tool calls are attributed to the single step of their owning
 * message.
 */
import { usageFromCounts } from '../../../model/token';
import type { Step, ToolCall } from '../../../model/types';
import { MESSAGE_TYPE } from '../../schema';
import { clampEnd, hasCompactionBetween, messagesIn, type SessionData } from './shared';

/**
 * Build one step per `assistant` message in scope:
 * `startedAt = data.time.created`, `endedAt = data.time.completed` (`null` =>
 * open step), `usage = data.tokens` (+ `data.cost`),
 * `modelId = data.model.id`, `reason = data.finish` (spec §3.1/G-1).
 */
export function buildSteps(
	sd: SessionData,
	restrict: Set<string> | null,
	compactionTimes: number[],
	now: number
): Step[] {
	const messages = messagesIn(sd.messages, restrict);
	const steps: Step[] = [];
	for (const message of messages) {
		if (message.role !== MESSAGE_TYPE.assistant) continue;
		const startedAt = message.startedAt;
		const { endedAt, flags } = clampEnd(startedAt, message.completedAt, now);
		steps.push({
			id: message.id,
			nodeId: message.sessionId,
			messageId: message.id,
			index: 0,
			startedAt,
			endedAt,
			open: message.completedAt === null,
			flags,
			reason: message.finish,
			usage: usageFromCounts(message.usage, message.cost),
			modelId: message.modelId ?? sd.session.modelId,
			hasCompaction: endedAt !== null && hasCompactionBetween(compactionTimes, startedAt, endedAt),
			toolCallIds: []
		});
	}
	return steps;
}

/**
 * Attribute every tool call to the single step of its owning message (decision
 * D-1). `callMessage` maps a call id to its message id; a message owns exactly
 * one step, so `Step.toolCallIds` ends up holding every tool item of that
 * message.
 */
export function linkTools(
	steps: Step[],
	calls: ToolCall[],
	callMessage: Map<string, string>
): void {
	const stepByMessage = new Map(steps.map((step) => [step.messageId, step]));
	for (const call of calls) {
		const messageId = callMessage.get(call.id);
		if (messageId === undefined) continue;
		const step = stepByMessage.get(messageId);
		if (step === undefined) continue;
		call.stepId = step.id;
		step.toolCallIds.push(call.id);
	}
}
