/**
 * Per-widget data lifecycle hook (dashboard Phase 3, task #410).
 *
 * Each widget body calls `useWidgetData` once; the returned state drives the
 * shared `WidgetCard` chrome. The hook owns exactly one request per widget:
 *
 * - The fetch starts in an `$effect`, so it only runs after mount (never in
 *   SSR). The `WidgetHost` lazy boundary means a below-the-fold widget does not
 *   even import this module until it scrolls into view.
 * - The effect cleanup aborts the in-flight request, so a period/scope change,
 *   a re-fetch or an unmount can never render a late response — each completed
 *   fetch is the only one allowed to write state.
 * - `refresh()` re-fetches this widget alone and always sends `?refresh=1`.
 * - A change to `refreshToken` (the shell's global counter) also re-fetches
 *   this widget with `?refresh=1`; sibling widgets are untouched.
 *
 * There is no shared/global request: every widget runs its own effect, so no
 * cross-widget waterfall exists. The pure helpers (`buildWidgetUrl`,
 * `defaultIsEmpty`) are exported separately so they stay testable without a
 * component or hydration context.
 */
import type { DashboardFilter } from '$lib/model/dashboard';
import type { WidgetStatus } from './widget';

/** The state a widget body renders and forwards to `WidgetCard`. */
export interface WidgetDataState<T> {
	/** Card chrome state; only `ready` shows the body. */
	readonly status: WidgetStatus;
	/** Last successful payload, or `null` while loading/errored. */
	readonly data: T | null;
	/** Human-readable failure message for the `error` state. */
	readonly error: string | null;
	/** True while a same-scope re-fetch is in flight (card disables its control). */
	readonly refreshing: boolean;
	/** Re-fetch this widget with `?refresh=1`; siblings are untouched. */
	readonly refresh: () => void;
}

export interface WidgetDataOptions<T> {
	/** Reactive widget endpoint getter, e.g. `() => widgetSource(widget.id)`. */
	source: () => string;
	/** Reactive filter accessor; read (and tracked) inside the effect. */
	filter: () => DashboardFilter;
	/** Reactive global refresh counter; a change re-fetches with `?refresh=1`. */
	refreshToken?: () => number;
	/** Empty-payload rule driving `status='empty'`; defaults to `defaultIsEmpty`. */
	isEmpty?: (data: T) => boolean;
	/** Injectable `fetch` (tests pass a stub); defaults to the global `fetch`. */
	fetcher?: typeof fetch;
}

/** `?scope=` value meaning "every directory" (server maps it back to `null`). */
const ALL_SCOPES = 'all';

/**
 * Build the widget URL from the source and filter. `refresh` adds `?refresh=1`,
 * which bypasses the server's short TTL for **this widget only**.
 */
export function buildWidgetUrl(
	source: string,
	filter: DashboardFilter,
	refresh: boolean
): string {
	const params = new URLSearchParams({
		period: filter.period,
		scope: filter.scope ?? ALL_SCOPES
	});
	if (refresh) params.set('refresh', '1');
	return `${source}?${params.toString()}`;
}

/** Default emptiness rule: `null`/`undefined`, or an empty array. */
export function defaultIsEmpty(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

/** The endpoint envelope (`src/routes/api/dashboard/widgets.ts`). */
interface WidgetEnvelope<T> {
	data: T;
}

/** Best-effort error text: the API's `error` field, else the HTTP status. */
async function responseError(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		if (
			body !== null &&
			typeof body === 'object' &&
			typeof (body as { error?: unknown }).error === 'string'
		) {
			return (body as { error: string }).error;
		}
	} catch {
		// Non-JSON error body: fall through to the status message.
	}
	return `Request failed (${response.status}).`;
}

/** Message for a rejected fetch (network failure, timeout, parse error, ...). */
function errorMessage(cause: unknown): string {
	return cause instanceof Error && cause.message.length > 0
		? cause.message
		: 'Something went wrong.';
}

/**
 * Fetch one widget's data with an independent loading/error/refresh lifecycle.
 * Must be called during component initialisation (it registers an `$effect`).
 */
export function useWidgetData<T>(options: WidgetDataOptions<T>): WidgetDataState<T> {
	const {
		source,
		filter,
		refreshToken = () => 0,
		isEmpty = defaultIsEmpty,
		fetcher = fetch
	} = options;

	let status = $state<WidgetStatus>('loading');
	let data = $state<T | null>(null);
	let error = $state<string | null>(null);
	let refreshing = $state(false);
	/** Per-widget refresh nonce; bumping it re-runs the effect. */
	let manual = $state(0);
	/** Last resolved `source|period|scope`; a mismatch means the scope changed. */
	let key = '';

	function refresh(): void {
		manual += 1;
	}

	$effect(() => {
		const current = filter();
		const token = refreshToken();
		const nextKey = `${source()}\u0000${current.period}\u0000${current.scope ?? ''}`;
		const first = key === '';
		const scopeChanged = nextKey !== key;
		key = nextKey;

		// A new period/scope invalidates the previous payload immediately (no
		// stale render); a same-scope re-run keeps the view and flags refreshing.
		if (scopeChanged) {
			status = 'loading';
			data = null;
			error = null;
		}
		const isRefresh = !first && !scopeChanged;
		if (isRefresh) refreshing = true;

		const controller = new AbortController();
		// `manual > 0` keeps the reactive dependency on the per-widget refresh
		// nonce and lets a post-refresh scope change skip the TTL cache too.
		const bypass = isRefresh || token > 0 || manual > 0;
		const url = buildWidgetUrl(source(), current, bypass);

		fetcher(url, { signal: controller.signal, headers: { accept: 'application/json' } })
			.then(async (response) => {
				if (!response.ok) throw new Error(await responseError(response));
				return (await response.json()) as WidgetEnvelope<T>;
			})
			.then((envelope) => {
				if (controller.signal.aborted) return;
				const payload: T | null = envelope?.data ?? null;
				data = payload;
				error = null;
				status = payload === null || isEmpty(payload) ? 'empty' : 'ready';
			})
			.catch((cause: unknown) => {
				if (controller.signal.aborted) return;
				data = null;
				error = errorMessage(cause);
				status = 'error';
			})
			.finally(() => {
				if (controller.signal.aborted) return;
				refreshing = false;
			});

		return () => controller.abort();
	});

	return {
		get status() {
			return status;
		},
		get data() {
			return data;
		},
		get error() {
			return error;
		},
		get refreshing() {
			return refreshing;
		},
		refresh
	};
}
