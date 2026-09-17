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
	 *
	 * The per-widget settings are threaded to the hook twice (task #529): the raw
	 * values feed the URL, while a `$derived` **signature string** is the fetch
	 * effect's dependency. A settings-map clone whose values for this widget are
	 * unchanged serialises to the same signature, so the shell re-renders without
	 * re-running the effect or aborting an in-flight request — only the widget
	 * whose values actually changed refetches.
	 */
	import type { DashboardFilter, WidgetDataMap } from '$lib/model/dashboard';
	import {
		widgetIsEmpty,
		widgetParams,
		widgetSource,
		type WidgetDefFor,
		type WidgetId,
		type WidgetSettingValues
	} from '$lib/widgets/registry';
	import { widgetSettingSignature } from '$lib/widgets/settings';
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
		/**
		 * This widget's resolved settings values; appended as `w.<key>=1|0`
		 * (task #520). Read only for the URL — the fetch effect depends on the
		 * derived signature, not on this object's identity (task #529).
		 */
		settings?: WidgetSettingValues;
		/** Opens this widget's settings modal. */
		onSettings?: () => void;
		/** Pure body renderer for this widget; the shell supplies the payload. */
		body?: WidgetRenderer<K>;
	}

	let { widget, filter, refreshToken, settings = {}, onSettings, body }: Props = $props();

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

	/**
	 * Canonical per-widget settings signature (task #529) — the fetch effect's
	 * settings dependency. Because it derives from **this widget's slice**, a
	 * settings-map clone with equal values yields the identical string, so the
	 * effect does not re-run (no aborted request, no refetch); a sibling widget's
	 * toggle replaces the shared map identity but leaves this signature unchanged.
	 * A real value change yields a new string and a fresh fetch.
	 */
	const settingsSignature = $derived(widgetSettingSignature(widget.id, settings));

	const state = useWidgetData<WidgetDataMap[K]>({
		source: () => widgetSource(widget.id),
		filter: () => filter,
		refreshToken: () => refreshToken,
		settings: () => settings,
		settingsSignature: () => settingsSignature,
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
