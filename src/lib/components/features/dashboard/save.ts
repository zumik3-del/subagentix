/**
 * Shared dashboard widget persistence (task #449).
 *
 * One `PUT /api/settings` path for both dashboard call sites: the global
 * picker (`WidgetsModal`, draft + Apply) and the per-widget gear
 * (`WidgetSettings`, immediate apply). `createCoalescingWriter` orders the
 * gear's rapid size changes so the last one always wins. Client-safe: no DOM,
 * no Svelte and no `$lib/server` import (docs/ui-standards.md §10).
 */
import { resolvePlacements } from '$lib/widgets/registry';
import type { WidgetPlacement } from '$lib/widgets/registry';

/** The server-normalised `dashboardWidgets`, falling back to the sent list. */
function savedPlacements(body: unknown, sent: readonly WidgetPlacement[]): WidgetPlacement[] {
	const raw =
		body !== null && typeof body === 'object'
			? (body as { dashboardWidgets?: unknown }).dashboardWidgets
			: undefined;
	return Array.isArray(raw) ? resolvePlacements(raw) : [...sent];
}

/**
 * Persist the full placement list under `dashboardWidgets` and return the
 * server-normalised placements. Throws an `Error` carrying the server's
 * `error` message (or the HTTP status) on a non-OK response.
 */
export async function saveDashboardWidgets(
	placements: readonly WidgetPlacement[],
	fetchImpl: typeof fetch = fetch
): Promise<WidgetPlacement[]> {
	const response = await fetchImpl('/api/settings', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ dashboardWidgets: placements })
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? `Could not save widgets (${response.status}).`);
	}
	const data = (await response.json()) as { dashboardWidgets?: unknown };
	return savedPlacements(data, placements);
}

/** A latest-wins save queue: rapid changes collapse into one trailing save. */
export interface CoalescingWriter {
	/** Queue `placements`; while a save is in flight only the latest is kept. */
	push(placements: readonly WidgetPlacement[]): void;
	/** Resolves once no save is in flight and nothing is queued. */
	idle(): Promise<void>;
}

/**
 * Build a coalescing writer around `save`. The gear can fire many saves while
 * one is in flight (fast `+`/`−` clicks); here a push replaces the queued list
 * and the drain loop saves exactly the latest one once the in-flight request
 * settles, so a stale size can never be persisted. `save` owns its own error
 * handling — it must settle, not reject — the writer only orders calls.
 */
export function createCoalescingWriter(
	save: (placements: readonly WidgetPlacement[]) => void | Promise<void>
): CoalescingWriter {
	let inFlight = false;
	let queued: WidgetPlacement[] | null = null;
	let waiters: (() => void)[] = [];

	async function drain(): Promise<void> {
		inFlight = true;
		try {
			while (queued !== null) {
				const next = queued;
				queued = null;
				await save(next);
			}
		} finally {
			inFlight = false;
			const pending = waiters;
			waiters = [];
			for (const resolve of pending) resolve();
		}
	}

	return {
		push(placements) {
			queued = [...placements];
			if (!inFlight) void drain().catch(() => {});
		},
		idle() {
			if (!inFlight && queued === null) return Promise.resolve();
			return new Promise((resolve) => waiters.push(resolve));
		}
	};
}
