/**
 * Shared primitives of the turn assembler: the internal glue types handed
 * between assembly modules, turn membership/window helpers, time
 * clamping/index helpers and usage arithmetic.
 *
 * None of this is part of the public DTO surface (`model/types.ts`); it exists
 * only to keep the domain logic in one direction (`shared` is a leaf).
 */
import { addUsage, emptyUsage } from '../../../model/token';
import type { Action, Marker, Node, Step, TimeFlag, ToolCall, Usage } from '../../../model/types';
import type { SessionSubtreeRecord } from '../../queries/sessions';
import {
	MESSAGE_TYPE,
	type ContentRecord,
	type DelegationRecord,
	type MessageRecord
} from '../../schema';

/**
 * Open upper bound of a turn window whose next trigger is unknown (the turn is
 * still running): {@link buildTurnWindow} uses it as the `end` so the half-open
 * window covers every later timestamp.
 */
export const TURN_WINDOW_END_FUTURE = Number.MAX_SAFE_INTEGER;

/** Every raw record one session contributes to a turn. */
export interface SessionData {
	session: SessionSubtreeRecord;
	messages: MessageRecord[];
	/** `tool` content items (`getToolParts`), one per tool call. */
	toolItems: ContentRecord[];
	/** `text`/`reasoning` content items (`getActionParts`). */
	actionItems: ContentRecord[];
	/** `type='compaction'` messages (`getCompactionParts`). */
	compactions: ContentRecord[];
}

/** A node plus the DTO slices it owns, as returned by the session assembler. */
export interface BuiltNode {
	node: Node;
	/** Raw (un-clamped) end, used for the turn's `t1` and overlap flags. */
	rawEnd: number | null;
	steps: Step[];
	toolCalls: ToolCall[];
	markers: Marker[];
	actions: Action[];
}

export function sumUsage(usages: Usage[]): Usage {
	return usages.reduce(addUsage, emptyUsage());
}

export function hasCompactionBetween(times: number[], start: number, end: number): boolean {
	return times.some((time) => time >= start && time <= end);
}

export function clampEnd(
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

export function edgeSortTime(edge: DelegationRecord): number {
	return edge.startedAt ?? edge.createdAt;
}

/** Index of the trigger whose half-open window contains `time` (ties -> later). */
export function turnIndexOf(time: number, triggers: MessageRecord[]): number {
	let index = 0;
	for (let i = 0; i < triggers.length; i++) {
		if (time >= triggers[i].startedAt) index = i;
		else break;
	}
	return index;
}

/**
 * Assistant message ids of a turn's `seq` window (decision D-2): the messages
 * after `trigger`, up to (excluding) `nextTrigger`. Shared by the turn assembler
 * and the node drill-down so both agree on turn membership.
 */
export function buildTurnMessageIds(
	messages: MessageRecord[],
	trigger: MessageRecord,
	nextTrigger: MessageRecord | null
): string[] {
	return messages
		.filter(
			(message) =>
				message.role === MESSAGE_TYPE.assistant &&
				message.seq > trigger.seq &&
				(nextTrigger === null || message.seq < nextTrigger.seq)
		)
		.map((message) => message.id);
}

/**
 * The root node's half-open turn window `[trigger.startedAt,
 * nextTrigger.startedAt)`, with the `end` falling back to
 * {@link TURN_WINDOW_END_FUTURE} while the turn is still open. Subagent nodes
 * are turn-scoped by construction and pass `undefined` instead.
 */
export function buildTurnWindow(
	trigger: MessageRecord,
	nextTrigger: MessageRecord | null
): { start: number; end: number } | undefined {
	return { start: trigger.startedAt, end: nextTrigger?.startedAt ?? TURN_WINDOW_END_FUTURE };
}

/**
 * Keep only the content items attached to a restricted message set, or return
 * them unchanged when no restriction applies. Every turn builder filters its
 * item lists this way, so the "restrict to these message ids" rule has one
 * definition. (Messages themselves are filtered on `m.id` by the assembler,
 * not through this helper.)
 */
export function itemsIn(
	items: ContentRecord[],
	restrict: ReadonlySet<string> | null
): ContentRecord[] {
	return restrict ? items.filter((item) => restrict.has(item.messageId)) : items;
}

/**
 * Keep only the messages attached to a restricted id set, or return them
 * unchanged when no restriction applies. Mirrors {@link itemsIn} for messages.
 */
export function messagesIn(
	messages: MessageRecord[],
	restrict: ReadonlySet<string> | null
): MessageRecord[] {
	return restrict ? messages.filter((m) => restrict.has(m.id)) : messages;
}
