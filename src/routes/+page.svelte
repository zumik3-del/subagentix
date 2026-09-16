<script lang="ts">
	/**
	 * Landing page (`/`) — the dashboard shell (dashboard Phase 3, task #404).
	 *
	 * The loader supplies the persisted widget selection only; this page owns the
	 * global filter's **URL state** (task #415): it derives `?period=&scope=`
	 * from the current URL, feeds the validated filter to the shell, and writes
	 * every selector change back with `goto` — so deep links and back/forward
	 * work and nothing is persisted server-side. Scope options reuse the
	 * sidebar's directory data; no DB work happens here (the loader reads
	 * settings.json only, and query-only `goto`s don't rerun loaders).
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
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const directories = $derived(data.sidebar?.directories ?? []);
	const knownScopes = $derived(directories.map((entry) => entry.directory));
	const scopes = $derived(directoryOptions(directories));
	const filter = $derived(parseFilter(page.url.searchParams, knownScopes));

	function onFilterChange(next: DashboardFilter): void {
		const url = new URL(page.url);
		url.search = filterSearch(next).toString();
		void goto(url, { keepFocus: true, noScroll: true });
	}
</script>

<Dashboard widgets={data.widgets} {filter} {scopes} onFilterChange={onFilterChange} />
