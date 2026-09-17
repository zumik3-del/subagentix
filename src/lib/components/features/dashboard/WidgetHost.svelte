<script lang="ts">
	/**
	 * Lazy widget mount boundary (dashboard Phase 3, task #409).
	 *
	 * Renders the static skeleton until the host scrolls into view
	 * (`IntersectionObserver`, ~200px prefetch margin), then calls the
	 * code-split `load` and swaps in the widget body. The observer disconnects
	 * after the first intersection and in the `$effect` cleanup, and the load
	 * is guarded, so a host never imports twice or writes state after destroy.
	 *
	 * Every body is content-only and is wrapped in the generic `WidgetShell`,
	 * which owns `useWidgetData` and the card chrome (task #490; the last
	 * self-shelled bodies migrated in #491).
	 *
	 * Data fetching belongs to `WidgetShell` (`useWidgetData`, task #410) — this
	 * component only gates mount/import and forwards `widgetProps`.
	 */
	import type { WidgetDef } from '$lib/widgets/registry';
	import type { WidgetBodyProps, WidgetComponent, WidgetLoader } from './widget';
	import SkeletonWidget from './SkeletonWidget.svelte';
	import WidgetCard from './WidgetCard.svelte';
	import WidgetShell from './WidgetShell.svelte';

	interface Props {
		/** Registry entry; supplies the skeleton title and body dimensions. */
		def: WidgetDef;
		/** Vite code-split loader; when absent the host stays a skeleton. */
		load?: WidgetLoader;
		/** Props forwarded to the loaded widget body (widget, filter, refreshToken). */
		widgetProps: WidgetBodyProps;
	}

	let { def, load, widgetProps }: Props = $props();

	let host: HTMLElement | undefined = $state();
	let visible = $state(false);
	let Widget: WidgetComponent | null = $state(null);
	let failed = $state(false);

	$effect(() => {
		const el = host;
		if (!el || visible) return;
		if (typeof IntersectionObserver === 'undefined') {
			// Observer unsupported (SSR-style test env / ancient browser): mount
			// eagerly rather than never; the lazy path is skipped, not broken.
			visible = true;
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					visible = true;
					observer.disconnect();
				}
			},
			{ rootMargin: '200px' }
		);
		observer.observe(el);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!visible || Widget || failed || !load) return;
		let cancelled = false;
		load()
			.then((module) => {
				if (!cancelled) Widget = module.default;
			})
			.catch(() => {
				if (!cancelled) failed = true;
			});
		return () => {
			cancelled = true;
		};
	});

	/** Re-run the failed import (the observer already disconnected). */
	function retry(): void {
		failed = false;
	}
</script>

<div class="widget-host" bind:this={host}>
	{#if Widget}
		<WidgetShell {...widgetProps} body={Widget} />
	{:else if failed}
		<WidgetCard
			title={def.title}
			status="error"
			error={`Failed to load the "${def.title}" widget.`}
			onRefresh={retry}
		/>
	{:else}
		<SkeletonWidget {def} />
	{/if}
</div>

<style>
	.widget-host {
		display: block;
		height: 100%;
		min-width: 0;
	}
</style>
