/**
 * Shared primitives of the turn assembler: the internal glue types handed
 * between assembly modules, time clamping/index helpers and usage arithmetic.
 *
 * None of this is part of the public DTO surface (`model/types.ts`); it exists
 * only to keep the domain logic in one direction (`shared` is a leaf).
 */
import { addUsage, emptyUsage, usageFromCounts } from '../../../model/token';
import type { Action, Marker, Node, Step, TimeFlag, ToolCall, Usage } from '../../../model/types';
import type { SessionSubtreeRecord } from '../../queries/sessions';
import type {
	DelegationRecord,
	MessageRecord,
	PartRecord,
	RemovedMarkerRecord
} from '../../schema';

/** Every raw record one session contributes to a turn. */
export interface SessionData {
	session: SessionSubtreeRecord;
	messages: MessageRecord[];
	stepParts: PartRecord[];
	toolParts: PartRecord[];
	actionParts: PartRecord[];
	compaction: PartRecord[];
	removed: RemovedMarkerRecord[];
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

export function subtractUsage(message: Usage, closed: Usage): Usage {
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
 * Keep only the parts attached to a restricted message set, or return them
 * unchanged when no restriction applies. Every turn builder filters its part
 * lists this way, so the "restrict to these message ids" rule has one
 * definition. (Messages themselves are filtered on `m.id` by the assembler,
 * not through this helper.)
 */
export function partsIn(parts: PartRecord[], restrict: ReadonlySet<string> | null): PartRecord[] {
	return restrict ? parts.filter((part) => restrict.has(part.messageId)) : parts;
}
