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
	import Dashboard from '$lib/components/features/dashboard/Dashboard.svelte';
	import {
		directoryOptions,
		filterSearch,
		parseFilter
	} from '$lib/components/features/dashboard/filter';
	import { createCoalescingWriter, saveDashboardFilter } from '$lib/components/features/dashboard/save';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const directories = $derived(data.sidebar?.directories ?? []);
	const knownScopes = $derived(directories.map((entry) => entry.directory));
	const scopes = $derived(directoryOptions(directories));

	/**
	 * Last resolved filter, kept so a URL-only change (opening/closing the error
	 * overlay via `pushState`, task #481) does not hand the grid a fresh object
	 * with the same period/scope — that would re-run every widget's fetch
	 * effect. Identity changes only when the filter actually changes.
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
	 * Tool whose error detail overlay is open (`?toolErrors=`), or `null`.
	 *
	 * This is local state, deliberately NOT derived from `page.url`: SvelteKit's
	 * `pushState` updates `page.state`, not `page.url` (only `popstate` refreshes
	 * `page.url`), so a `page.url`-derived value never reacted to opening the
	 * overlay and nothing appeared. The URL is still kept in sync so a deep link
	 * and a reload restore the overlay, and `popstate` re-seeds this state so
	 * browser Back/Forward open and close it.
	 */
	let errorTool = $state<string | null>(page.url.searchParams.get('toolErrors'));

	/**
	 * True while the overlay was opened from this page. The close path then uses
	 * `history.back()` (returning to the pre-open entry) instead of replacing the
	 * entry; a deep-linked overlay with no prior entry closes by `replaceState`
	 * so the browser never leaves the app.
	 */
	let pushedByUs = false;

	/** The current URL with `?toolErrors=` set (`tool`) or removed (`null`). */
	function overlayUrl(tool: string | null): URL {
		const url = new URL(location.href);
		if (tool === null) url.searchParams.delete('toolErrors');
		else url.searchParams.set('toolErrors', tool);
		return url;
	}

	/**
	 * Open/close the error overlay. The state is local (see above), so the grid,
	 * its widgets and their data all survive; the shallow history API keeps the
	 * URL shareable and makes browser Back close the overlay.
	 */
	function onToolErrorsChange(tool: string | null): void {
		if (tool !== null) {
			if (tool === errorTool) return;
			errorTool = tool;
			pushedByUs = true;
			pushState(overlayUrl(tool), {});
			return;
		}
		if (errorTool === null) return;
		errorTool = null;
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
			errorTool = new URL(location.href).searchParams.get('toolErrors');
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
	{errorTool}
	onToolErrorsChange={onToolErrorsChange}
/>
