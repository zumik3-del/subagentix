/**
 * Per-widget data lifecycle hook (dashboard Phase 3, task #410).
 *
 * Each widget body calls `useWidgetData` once; the returned state drives the
 * shared `WidgetCard` chrome. The hook owns exactly one request per widget:
 *
 * - The fetch starts in an `$effect`, so it only runs after mount (never in
 *   SSR). The `WidgetHost` lazy boundary means a below-the-fold widget does not
 *   even import this module until it scrolls into view.
 * - Abort ownership lives outside the effect: the in-flight `AbortController`
 *   is held in a mutable variable, aborted explicitly right before a replacement
 *   request and by `onDestroy`. A period/scope change, a re-fetch or an unmount
 *   therefore never renders a late response — each completed fetch is the only
 *   one allowed to write state. The effect returns no cleanup (task #532).
 * - A re-run with no relevant change is a true no-op (task #532): the effect
 *   first computes the key and the refresh triggers and returns with no state
 *   write, fetch or abort. Svelte 5 can propagate a dirty `$derived` signature
 *   even when the string is unchanged, so without this guard such a spurious run
 *   would take the refresh branch and abort/refetch every widget with
 *   `?refresh=1`.
 * - `refresh()` re-fetches this widget alone and always sends `?refresh=1`.
 * - A change to `refreshToken` (the shell's global counter) also re-fetches
 *   this widget with `?refresh=1`; sibling widgets are untouched.
 * - A change to the widget's settings **signature** (task #520, identity fix
 *   #529) is a scope change: the stale payload is cleared and the widget
 *   re-fetches with the new `w.<key>=1|0` params, which is a fresh server cache
 *   key (no `refresh=1` required). The effect depends on the signature string,
 *   never on the settings object identity, so a cloned map with equal
 *   per-widget values is a no-op: no re-run, no aborted request, no refetch.
 *
 * There is no shared/global request: every widget runs its own effect, so no
 * cross-widget waterfall exists. The pure helpers (`buildWidgetUrl`,
 * `widgetFetchKey`, `defaultIsEmpty`) are exported separately so they stay
 * testable without a component or hydration context.
 */
import { onDestroy, untrack } from 'svelte';
import type { DashboardFilter } from '$lib/model/dashboard';
import { isWidgetId, type WidgetId, type WidgetSettingValues } from '$lib/widgets/registry';
import { widgetSettingParams } from '$lib/widgets/settings';
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
	/**
	 * Reactive per-widget settings **values** (task #520); read (untracked)
	 * only to build the `w.<key>=1|0` URL params. They are deliberately not an
	 * effect dependency — `settingsSignature` is. Absent/empty means no
	 * settings (no `w.*` params).
	 */
	settings?: () => WidgetSettingValues;
	/**
	 * Reactive canonical **signature** of this widget's settings (task #529),
	 * e.g. `() => widgetSettingSignature(widget.id, settings)`. This string is
	 * the effect's settings dependency: identical per-widget values serialise to
	 * the same string even when the settings map (and this widget's slice) got a
	 * fresh identity, so a cloned map cannot re-run the effect. Absent means
	 * `''` (a widget with no settings, whose key never changes with values).
	 */
	settingsSignature?: () => string;
	/** Empty-payload rule driving `status='empty'`; defaults to `defaultIsEmpty`. */
	isEmpty?: (data: T) => boolean;
	/** Injectable `fetch` (tests pass a stub); defaults to the global `fetch`. */
	fetcher?: typeof fetch;
}

/** `?scope=` value meaning "every directory" (server maps it back to `null`). */
const ALL_SCOPES = 'all';

/**
 * The widget id encoded in a widget endpoint (`/api/dashboard/<id>`), or `null`
 * for a source the registry does not define. The settings wire params are keyed
 * off it, so the pure `buildWidgetUrl` can stay a source-based function; the
 * effect key no longer needs it because the caller supplies the signature.
 */
function widgetIdFromSource(source: string): WidgetId | null {
	const segment = source.split('?')[0].split('/').filter(Boolean).pop();
	return segment !== undefined && isWidgetId(segment) ? segment : null;
}

/**
 * Build the widget URL from the source, filter and settings. `refresh` adds
 * `?refresh=1`, which bypasses the server's short TTL for **this widget only**;
 * `settings` appends the widget's `w.<key>=1|0` params (task #520). A source
 * with no registered id, an absent settings map, or a widget that declares no
 * settings all yield no `w.*` params (back-compat with a stale bundle).
 */
export function buildWidgetUrl(
	source: string,
	filter: DashboardFilter,
	refresh: boolean,
	settings?: WidgetSettingValues
): string {
	const params = new URLSearchParams({
		period: filter.period,
		scope: filter.scope ?? ALL_SCOPES
	});
	if (refresh) params.set('refresh', '1');
	if (settings) {
		const id = widgetIdFromSource(source);
		if (id) {
			for (const [key, value] of Object.entries(widgetSettingParams(id, settings))) {
				params.set(key, value);
			}
		}
	}
	return `${source}?${params.toString()}`;
}

/** Default emptiness rule: `null`/`undefined`, or an empty array. */
export function defaultIsEmpty(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

/**
 * The effect key for one widget fetch: source, period, scope and the settings
 * signature (task #520; signature-keyed in #529). The signature is passed in
 * already computed from the per-widget values, so the key never touches the
 * settings object identity: a cloned map with equal values keeps the same key
 * (no re-run), while any value change yields a new key — treated as a scope
 * change by the hook, which clears the stale payload and re-fetches from a
 * fresh server cache key. Pure so it is testable without a component or
 * hydration context.
 */
export function widgetFetchKey(
	source: string,
	filter: DashboardFilter,
	settingsSignature: string
): string {
	return `${source}\u0000${filter.period}\u0000${filter.scope ?? ''}\u0000${settingsSignature}`;
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
 *
 * The `$effect` deliberately returns **no** cleanup (task #532). A cleanup runs
 * on *every* re-run, so for a spurious re-run — Svelte 5 can propagate a dirty
 * `$derived` settings signature even when the string is unchanged — it would
 * abort the still-current in-flight request before the body could notice that
 * nothing changed, and the run would then refetch with `?refresh=1`. Instead the
 * in-flight controller is held in a mutable variable here: a new request aborts
 * it explicitly just before starting, and `onDestroy` aborts it on unmount.
 */
export function useWidgetData<T>(options: WidgetDataOptions<T>): WidgetDataState<T> {
	const {
		source,
		filter,
		refreshToken = () => 0,
		settings = () => ({}),
		settingsSignature = () => '',
		isEmpty = defaultIsEmpty,
		fetcher = fetch
	} = options;

	let status = $state<WidgetStatus>('loading');
	let data = $state<T | null>(null);
	let error = $state<string | null>(null);
	let refreshing = $state(false);
	/** Per-widget refresh nonce; bumping it re-runs the effect. */
	let manual = $state(0);
	/** Last resolved `source|period|scope|signature`; a mismatch means a scope change. */
	let key = '';
	/** Last seen refresh triggers; a mismatch means a real `refresh()`/token change. */
	let lastToken = 0;
	let lastManual = 0;
	/** In-flight request; aborted explicitly by a replacement or on destroy (task #532). */
	let controller: AbortController | null = null;

	function refresh(): void {
		manual += 1;
	}

	onDestroy(() => {
		controller?.abort();
		controller = null;
	});

	$effect(() => {
		const current = filter();
		const token = refreshToken();
		const currentSource = source();
		// The settings *signature* is the tracked dependency (task #529): a fresh
		// map identity with equal per-widget values serialises to the same string,
		// so this effect — and any in-flight request — is left untouched. The
		// values themselves are read untracked below, purely for the URL, so a run
		// triggered by a real signature change still sees the current values.
		const currentSignature = settingsSignature();
		// A settings value change is a scope change for this widget (task #520):
		// it invalidates the payload immediately and re-fetches a fresh cache key,
		// so no `refresh=1` is needed to clear the stale server payload.
		const nextKey = widgetFetchKey(currentSource, current, currentSignature);
		const first = key === '';
		const scopeChanged = nextKey !== key;
		const tokenChanged = token !== lastToken;
		const manualChanged = manual !== lastManual;

		// Spurious re-run (task #532): nothing relevant changed, so this is a true
		// no-op — no state write, no fetch, no abort. The in-flight request (if any)
		// stays untouched instead of being aborted and re-issued with `refresh=1`.
		if (!first && !scopeChanged && !tokenChanged && !manualChanged) return;

		key = nextKey;
		lastToken = token;
		lastManual = manual;

		// A new period/scope/settings invalidates the previous payload immediately
		// (no stale render); a same-scope re-run keeps the view and flags refreshing.
		if (scopeChanged) {
			status = 'loading';
			data = null;
			error = null;
		}
		const isRefresh = !first && !scopeChanged;
		if (isRefresh) refreshing = true;

		// Only a real new request replaces and aborts the previous one (task #532):
		// a no-op re-run returned above without touching the in-flight request.
		controller?.abort();
		const active = new AbortController();
		controller = active;

		// `manual > 0` keeps the reactive dependency on the per-widget refresh
		// nonce and lets a post-refresh scope change skip the TTL cache too.
		const bypass = isRefresh || token > 0 || manual > 0;
		const currentSettings = untrack(() => settings());
		const url = buildWidgetUrl(currentSource, current, bypass, currentSettings);

		fetcher(url, { signal: active.signal, headers: { accept: 'application/json' } })
			.then(async (response) => {
				if (!response.ok) throw new Error(await responseError(response));
				return (await response.json()) as WidgetEnvelope<T>;
			})
			.then((envelope) => {
				if (active.signal.aborted) return;
				const payload: T | null = envelope?.data ?? null;
				data = payload;
				error = null;
				status = payload === null || isEmpty(payload) ? 'empty' : 'ready';
			})
			.catch((cause: unknown) => {
				if (active.signal.aborted) return;
				data = null;
				error = errorMessage(cause);
				status = 'error';
			})
			.finally(() => {
				if (active.signal.aborted) return;
				refreshing = false;
			});
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
