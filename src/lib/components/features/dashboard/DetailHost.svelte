<script lang="ts">
	/**
	 * Single detail-overlay mount (dashboard widget engine, task #492).
	 *
	 * Mounted once by the dashboard shell (`Dashboard.svelte`). It resolves the
	 * current {@link DetailTarget} to its registry {@link DetailDef}, lazily
	 * imports that detail's component (Vite code-splits it) and renders it with
	 * the target spread in plus the shared shell props. Closing goes through the
	 * context controls, so no widget body or intermediate component threads a
	 * detail callback.
	 *
	 * The loader effect only runs in the browser, so SSR renders nothing for an
	 * open deep link; the overlay appears right after hydration. A target change
	 * while a load is in flight cancels the stale import.
	 */
	import type { DashboardFilter } from '$lib/model/dashboard';
	import { DETAIL_DEFS, getDetailControls, type DetailComponent, type DetailTarget } from './detail';
	import { DEFAULT_FILTER, type FilterOption } from './filter';

	interface Props {
		/** Currently open detail target, or `null` while closed. */
		target?: DetailTarget | null;
		/** Active global filter, forwarded to the detail component. */
		filter?: DashboardFilter;
		/** Directory options for the detail's project filter. */
		scopes?: readonly FilterOption[];
	}

	let { target = null, filter = DEFAULT_FILTER, scopes = [] }: Props = $props();

	/** Overlay controls from the shell; `undefined` in a standalone render. */
	const controls = getDetailControls();

	/** Loaded detail component, or `null` while closed/loading/failed. */
	let loaded = $state<DetailComponent | null>(null);

	$effect(() => {
		const current = target;
		// A new target never reuses the previous component (the kind may differ).
		loaded = null;
		if (current === null) return;
		let cancelled = false;
		DETAIL_DEFS[current.kind]
			.load()
			.then((module) => {
				if (!cancelled) loaded = module.default;
			})
			.catch(() => {
				// A failed import leaves the overlay closed; the widget remains usable.
			});
		return () => {
			cancelled = true;
		};
	});

	function close(): void {
		controls?.closeDetail();
	}
</script>

{#if target !== null && loaded !== null}
	{@const Detail = loaded}
	<!-- The target carries `tool`/`mode`; the shell props complete the contract. -->
	<Detail
		{...target}
		title={DETAIL_DEFS[target.kind].title}
		{filter}
		{scopes}
		onClose={close}
	/>
{/if}
