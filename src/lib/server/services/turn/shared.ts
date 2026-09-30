/**
 * Shared primitives of the turn assembler: the internal glue types handed
 * between assembly modules, time clamping/index helpers and usage arithmetic.
 *
 * None of this is part of the public DTO surface (`model/types.ts`); it exists
 * only to keep the domain logic in one direction (`shared` is a leaf).
 */
import { addUsage, emptyUsage } from '../../../model/token';
import type { Action, Marker, Node, Step, TimeFlag, ToolCall, Usage } from '../../../model/types';
import type { SessionSubtreeRecord } from '../../queries/sessions';
import type { ContentRecord, DelegationRecord, MessageRecord } from '../../schema';

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
