<script lang="ts">
	/**
	 * Landing page (`/`) — the dashboard shell (dashboard Phase 3, task #404).
	 *
	 * The loader supplies the persisted widget selection and the stored filter
	 * preference; this page owns the global filter's URL state (task #415) and
	 * its persistence (task #457): it derives `?period=&scope=` from the current
	 * URL (falling back to the stored preference and then the default), feeds
	 * the validated filter to the shell, and writes every manual selector change
	 * both back to the URL with `goto` and to the server through one
	 * `/api/settings` PUT. Deep links stay read-only for the preference: only a
	 * selector change saves. Scope options reuse the sidebar's directory data;
	 * no DB work happens here (the loader reads settings.json only).
	 */
	import { goto, pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { DashboardFilter } from '$lib/model/dashboard';
	import type { ToolCallDetail } from '$lib/model/tool-errors';
	import Dashboard from '$lib/components/features/dashboard/Dashboard.svelte';
	import {
		directoryOptions,
		filterSearch,
		parseFilter
	} from '$lib/components/features/dashboard/filter';
	import {
		TOOL_CALLS_PARAM,
		TOOL_ERRORS_PARAM
	} from '$lib/components/features/dashboard/detail';
	import { createCoalescingWriter, saveDashboardFilter } from '$lib/components/features/dashboard/save';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const directories = $derived(data.sidebar?.directories ?? []);
	const knownScopes = $derived(directories.map((entry) => entry.directory));
	const scopes = $derived(directoryOptions(directories));

	/**
	 * Read the overlay target from a query string. `?toolErrors=` wins over
	 * `?toolCalls=` (they are mutually exclusive, so a hand-edited URL with both
	 * still resolves deterministically); blank values are ignored.
	 */
	function readToolDetail(search: URLSearchParams): ToolCallDetail | null {
		const errorsTool = search.get(TOOL_ERRORS_PARAM);
		if (errorsTool !== null && errorsTool !== '') return { tool: errorsTool, mode: 'errors' };
		const callsTool = search.get(TOOL_CALLS_PARAM);
		if (callsTool !== null && callsTool !== '') return { tool: callsTool, mode: 'all' };
		return null;
	}

	/**
	 * Last resolved filter, kept so a URL-only change (opening/closing the
	 * tool-call overlay via `pushState`, tasks #481/#484) does not hand the grid
	 * a fresh object with the same period/scope — that would re-run every
	 * widget's fetch effect. Identity changes only when the filter actually
	 * changes.
	 */
	let previousFilter: DashboardFilter | null = null;
	const filter = $derived.by((): DashboardFilter => {
		const next = parseFilter(page.url.searchParams, knownScopes, data.filter);
		if (
			previousFilter !== null &&
			previousFilter.period === next.period &&
			previousFilter.scope === next.scope
		) {
			return previousFilter;
		}
		previousFilter = next;
		return next;
	});

	/**
	 * Tool-call detail overlay target (`{ tool, mode }`), or `null`.
	 *
	 * This is local state, deliberately NOT derived from `page.url`: SvelteKit's
	 * `pushState` updates `page.state`, not `page.url` (only `popstate` refreshes
	 * `page.url`), so a `page.url`-derived value never reacted to opening the
	 * overlay and nothing appeared. The URL is still kept in sync so a deep link
	 * and a reload restore the overlay, and `popstate` re-seeds this state so
	 * browser Back/Forward open and close it.
	 *
	 * The mode is URL-visible and mutually exclusive (task #484): `?toolErrors=`
	 * is failures only, `?toolCalls=` is every call.
	 */
	let toolDetail = $state<ToolCallDetail | null>(readToolDetail(page.url.searchParams));

	/**
	 * True while the overlay was opened from this page. The close path then uses
	 * `history.back()` (returning to the pre-open entry) instead of replacing the
	 * entry; a deep-linked overlay with no prior entry closes by `replaceState`
	 * so the browser never leaves the app.
	 */
	let pushedByUs = false;

	/** The current URL with the overlay params cleared, then the active one set. */
	function overlayUrl(detail: ToolCallDetail | null): URL {
		const url = new URL(location.href);
		url.searchParams.delete(TOOL_ERRORS_PARAM);
		url.searchParams.delete(TOOL_CALLS_PARAM);
		if (detail !== null) {
			url.searchParams.set(
				detail.mode === 'errors' ? TOOL_ERRORS_PARAM : TOOL_CALLS_PARAM,
				detail.tool
			);
		}
		return url;
	}

	/**
	 * Open/close the tool-call detail overlay. The state is local (see above), so
	 * the grid, its widgets and their data all survive; the shallow history API
	 * keeps the URL shareable and makes browser Back close the overlay.
	 */
	function onToolDetailChange(detail: ToolCallDetail | null): void {
		if (detail !== null) {
			if (
				toolDetail !== null &&
				toolDetail.tool === detail.tool &&
				toolDetail.mode === detail.mode
			) {
				return;
			}
			toolDetail = detail;
			pushedByUs = true;
			pushState(overlayUrl(detail), {});
			return;
		}
		if (toolDetail === null) return;
		toolDetail = null;
		if (pushedByUs) {
			pushedByUs = false;
			window.history.back();
		} else {
			replaceState(overlayUrl(null), {});
		}
	}

	// Browser Back/Forward re-seeds the overlay state from the address bar, so a
	// history move both closes an open overlay and restores one that was opened.
	$effect(() => {
		const sync = () => {
			pushedByUs = false;
			toolDetail = readToolDetail(new URL(location.href).searchParams);
		};
		window.addEventListener('popstate', sync);
		return () => window.removeEventListener('popstate', sync);
	});

	// Persist the preference through the shared coalescing writer: rapid selector
	// changes collapse into one trailing PUT. A failed write is swallowed — it
	// must never break the navigation or the rendered filter (and the diagnostic
	// stays out of the UI); the next manual change retries it.
	const filterWriter = createCoalescingWriter<DashboardFilter>(async (next) => {
		try {
			await saveDashboardFilter(next);
		} catch {
			// Intentionally ignored: the URL state is already updated.
		}
	});

	function onFilterChange(next: DashboardFilter): void {
		const url = new URL(page.url);
		url.search = filterSearch(next).toString();
		void goto(url, { keepFocus: true, noScroll: true });
		filterWriter.push(next);
	}
</script>

<Dashboard
	widgets={data.widgets}
	{filter}
	{scopes}
	onFilterChange={onFilterChange}
	{toolDetail}
	onToolDetailChange={onToolDetailChange}
/>
