<script lang="ts" generics="K extends WidgetId">
	/**
	 * Generic widget shell (dashboard widget engine, task #490).
	 *
	 * Owns the per-widget data lifecycle and card chrome: it calls
	 * `useWidgetData` with the descriptor's endpoint and emptiness rule, renders
	 * the shared `WidgetCard` (title, loading/error/empty states, refresh, gear)
	 * and hands the typed payload to the pure body renderer once the card is
	 * ready. A migrated body is content-only: it never fetches and never touches
	 * the card.
	 *
	 * `K` is inferred from the descriptor, so `body` receives exactly
	 * `WidgetDataMap[K]` — no per-widget fetch boilerplate, no payload cast at the
	 * body boundary.
	 */
	import type { DashboardFilter, WidgetDataMap } from '$lib/model/dashboard';
	import {
		widgetIsEmpty,
		widgetParams,
		widgetSource,
		type WidgetDefFor,
		type WidgetId
	} from '$lib/widgets/registry';
	import type { WidgetRenderer } from './widget';
	import { defaultIsEmpty, useWidgetData } from './data.svelte';
	import WidgetCard from './WidgetCard.svelte';

	interface Props {
		/** Registry descriptor for this widget; supplies the title and endpoint id. */
		widget: WidgetDefFor<K>;
		/** Active global filter, shared by every widget. */
		filter: DashboardFilter;
		/** Global refresh counter; a change refetches this widget with `refresh=1`. */
		refreshToken: number;
		/** Opens this widget's size-settings modal. */
		onSettings?: () => void;
		/** Pure body renderer for this widget; the shell supplies the payload. */
		body?: WidgetRenderer<K>;
	}

	let { widget, filter, refreshToken, onSettings, body }: Props = $props();

	/**
	 * The descriptor's emptiness rule, narrowed to this widget's payload. Only
	 * some registry entries carry an explicit `isEmpty` (the rest use the hook's
	 * default), so it is read lazily through the id-keyed accessor — which also
	 * keeps the `widget` prop inside a closure (Svelte 5 prop-access rule).
	 */
	function isEmpty(data: WidgetDataMap[K]): boolean {
		const rule = widgetIsEmpty(widget.id);
		return rule ? rule(data) : defaultIsEmpty(data);
	}

	const state = useWidgetData<WidgetDataMap[K]>({
		source: () => widgetSource(widget.id),
		filter: () => filter,
		refreshToken: () => refreshToken,
		isEmpty
	});
</script>

<WidgetCard
	title={widget.title}
	status={state.status}
	error={state.error ?? undefined}
	refreshing={state.refreshing}
	onRefresh={state.refresh}
	{onSettings}
>
	{#if body && state.data !== null}
		{@const Body = body}
		<!-- The descriptor params come first so the shell-owned props always win. -->
		<Body {...widgetParams(widget.id)} data={state.data} {filter} {onSettings} />
	{/if}
</WidgetCard>
