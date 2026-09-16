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
	import { goto } from '$app/navigation';
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
	const filter = $derived(parseFilter(page.url.searchParams, knownScopes, data.filter));

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

<Dashboard widgets={data.widgets} {filter} {scopes} onFilterChange={onFilterChange} />
