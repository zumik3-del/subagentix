/**
 * Shared dashboard persistence (task #449; filter preference #457; per-widget
 * settings #516).
 *
 * One `PUT /api/settings` path for the dashboard's persisted UI state: the
 * global picker (`WidgetsModal`, draft + Apply) and the per-widget gear
 * (`WidgetSettings`, immediate apply) write `dashboardWidgets`, the gear also
 * writes `dashboardWidgetSettings`, and the landing page writes
 * `dashboardFilter` on a manual selector change.
 * `createCoalescingWriter` orders rapid changes so the last one always wins.
 * Client-safe: no DOM, no Svelte and no `$lib/server` import.
 */
import { isDashboardPeriod } from '$lib/model/dashboard';
import type { DashboardFilter } from '$lib/model/dashboard';
import { resolvePlacements, WIDGET_IDS } from '$lib/widgets/registry';
import type { WidgetId, WidgetPlacement, WidgetSettingValues } from '$lib/widgets/registry';
import { coerceWidgetSettingValues } from '$lib/widgets/settings';

/** The server-normalised `dashboardWidgets`, falling back to the sent list. */
function savedPlacements(body: unknown, sent: readonly WidgetPlacement[]): WidgetPlacement[] {
	const raw =
		body !== null && typeof body === 'object'
			? (body as { dashboardWidgets?: unknown }).dashboardWidgets
			: undefined;
	return Array.isArray(raw) ? resolvePlacements(raw) : [...sent];
}

/** The server-normalised `dashboardFilter`, falling back to the sent pair. */
function savedFilter(body: unknown, sent: DashboardFilter): DashboardFilter {
	const raw =
		body !== null && typeof body === 'object'
			? (body as { dashboardFilter?: unknown }).dashboardFilter
			: undefined;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...sent };
	const record = raw as { period?: unknown; scope?: unknown };
	return {
		period: isDashboardPeriod(record.period) ? record.period : sent.period,
		scope: typeof record.scope === 'string' ? record.scope : null
	};
}

/**
 * The server-normalised per-widget settings map, falling back to the sent map.
 * The server echoes the effective map for every registered id; each entry is
 * coerced through the shared pure contract so a malformed response degrades to
 * the registry defaults instead of leaking a bad value.
 */
function savedWidgetSettings(
	body: unknown,
	sent: Record<WidgetId, WidgetSettingValues>
): Record<WidgetId, WidgetSettingValues> {
	const raw =
		body !== null && typeof body === 'object'
			? (body as { dashboardWidgetSettings?: unknown }).dashboardWidgetSettings
			: undefined;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...sent };
	const record = raw as Record<string, unknown>;
	const resolved = {} as Record<WidgetId, WidgetSettingValues>;
	for (const id of WIDGET_IDS) resolved[id] = coerceWidgetSettingValues(id, record[id]);
	return resolved;
}

/** The dashboard persistence fields managed via `PUT /api/settings`. */
type SettingsField = 'dashboardWidgets' | 'dashboardWidgetSettings' | 'dashboardFilter';

/**
 * Shared `PUT /api/settings` path for the dashboard's persisted UI state:
 * send one `field`, then normalise the server's echo of that field through
 * `normalize` (falling back to the sent value on an absent/malformed echo).
 * Throws an `Error` carrying the server's `error` message (or the HTTP
 * status) on a non-OK response; callers that must not break the UI swallow it.
 */
async function putSettings<T>(
	field: SettingsField,
	send: unknown,
	label: string,
	normalize: (raw: unknown) => T,
	fetchImpl: typeof fetch = fetch
): Promise<T> {
	const response = await fetchImpl('/api/settings', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ [field]: send })
	});
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? `Could not save ${label} (${response.status}).`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return normalize(data);
}

/**
 * Persist the full placement list under `dashboardWidgets` and return the
 * server-normalised placements.
 */
export async function saveDashboardWidgets(
	placements: readonly WidgetPlacement[],
	fetchImpl: typeof fetch = fetch
): Promise<WidgetPlacement[]> {
	return putSettings(
		'dashboardWidgets',
		placements,
		'widgets',
		(raw) => savedPlacements(raw, placements),
		fetchImpl
	);
}

/**
 * Persist the full per-widget settings map under `dashboardWidgetSettings` and
 * return the server-normalised map (an entry per registered id).
 */
export async function saveDashboardWidgetSettings(
	all: Record<WidgetId, WidgetSettingValues>,
	fetchImpl: typeof fetch = fetch
): Promise<Record<WidgetId, WidgetSettingValues>> {
	return putSettings(
		'dashboardWidgetSettings',
		all,
		'widget settings',
		(raw) => savedWidgetSettings(raw, all),
		fetchImpl
	);
}

/**
 * Persist the global period/scope filter under `dashboardFilter` and return the
 * server-normalised pair. The landing page swallows a rejection so a failed
 * preference write never breaks the navigation or the rendered filter.
 */
export async function saveDashboardFilter(
	filter: DashboardFilter,
	fetchImpl: typeof fetch = fetch
): Promise<DashboardFilter> {
	return putSettings('dashboardFilter', filter, 'filter', (raw) => savedFilter(raw, filter), fetchImpl);
}

/** A latest-wins save queue: rapid changes collapse into one trailing save. */
export interface CoalescingWriter<T> {
	/** Queue `value`; while a save is in flight only the latest is kept. */
	push(value: T): void;
	/** Resolves once no save is in flight and nothing is queued. */
	idle(): Promise<void>;
}

/**
 * Build a coalescing writer around `save`. The gear can fire many saves while
 * one is in flight (fast `+`/`−` clicks) and the filter selector can fire a
 * save per change; here a push replaces the queued value and the drain loop
 * saves exactly the latest one once the in-flight request settles, so a stale
 * value can never be persisted. `save` owns its own error handling — it must
 * settle, not reject — the writer only orders calls. A pushed value is treated
 * as an immutable snapshot by the caller (the call sites build fresh arrays or
 * objects); the writer stores the reference rather than cloning it.
 */
export function createCoalescingWriter<T>(
	save: (value: T) => void | Promise<void>
): CoalescingWriter<T> {
	let inFlight = false;
	let queued: { value: T } | null = null;
	let waiters: (() => void)[] = [];

	async function drain(): Promise<void> {
		inFlight = true;
		try {
			while (queued !== null) {
				const next = queued.value;
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
		push(value) {
			queued = { value };
			if (!inFlight) void drain().catch(() => {});
		},
		idle() {
			if (!inFlight && queued === null) return Promise.resolve();
			return new Promise((resolve) => waiters.push(resolve));
		}
	};
}
