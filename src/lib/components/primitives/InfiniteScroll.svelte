<script lang="ts">
	/**
	 * Infinite-scroll boundary (task #544).
	 *
	 * The single, uniform "load more when the reader reaches the end" pattern:
	 * a sentinel element sits at the end of a list inside a `ScrollView` and an
	 * `IntersectionObserver` calls `onReach` once the sentinel comes near the
	 * viewport bottom (`rootMargin`). There is no "Load more" button — the next
	 * page loads as the reader approaches the end.
	 *
	 * Owned here, so every caller behaves alike:
	 *
	 * - At most one `onReach` request in flight (`busy` guards a racing observer),
	 *   reset synchronously by the caller as soon as its fetch settles.
	 * - The observer disconnects in the `$effect` cleanup, so a filter change or
	 *   unmount can never leave a live observer.
	 * - `hasMore` false renders nothing (not even the sentinel), so a completed
	 *   list stops observing.
	 * - No `IntersectionObserver` (SSR/test harness): the sentinel still renders,
	 *   but nothing fires — the caller's first page stays the only page.
	 *
	 * The caller owns data: render it, set `busy`/`hasMore`, and report load
	 * failures via the `error` prop (or its own inline alert); this primitive
	 * renders the busy/error/end affordances and the sentinel.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		/** Called when the sentinel nears the viewport and no request is in flight. */
		onReach: () => void;
		/** More pages exist; when `false` the sentinel and affordances vanish. */
		hasMore: boolean;
		/** A request is in flight; suppresses further `onReach` calls. */
		busy?: boolean;
		/** Last load failure; rendered inline with `role="alert"`. */
		error?: string | null;
		/** Distance from the viewport bottom that triggers the next page. */
		rootMargin?: string;
		/** Copy shown while a request is in flight. */
		loadingLabel?: string;
		/** Copy shown when every page is loaded (only for finite lists). */
		endLabel?: string;
		class?: string;
		/** Optional extra content rendered inside the sentinel. */
		children?: Snippet;
	}

	let {
		onReach,
		hasMore,
		busy = false,
		error = null,
		rootMargin = '200px',
		loadingLabel = 'Loading…',
		endLabel = '',
		class: className = '',
		children
	}: Props = $props();

	let sentinel: HTMLDivElement | null = $state(null);

	$effect(() => {
		const el = sentinel;
		// Only observe while there is something to fetch and no request in
		// flight; a busy tick re-runs this effect and detaches the observer.
		if (!el || !hasMore || busy) return;
		if (typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onReach();
			},
			{ rootMargin }
		);
		observer.observe(el);
		return () => observer.disconnect();
	});
</script>

{#if hasMore || error || busy || endLabel}
	<div class={`infinite-scroll ${className}`}>
		{#if error}
			<p class="infinite-scroll__error" role="alert">{error}</p>
		{/if}
		{#if hasMore}
			<div class="infinite-scroll__sentinel" bind:this={sentinel}>
				{#if busy}
					<span class="infinite-scroll__busy" role="status">{loadingLabel}</span>
				{/if}
				{@render children?.()}
			</div>
		{:else if endLabel}
			<p class="infinite-scroll__end">{endLabel}</p>
		{/if}
	</div>
{/if}

<style>
	.infinite-scroll {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3) 0;
	}

	.infinite-scroll__sentinel {
		display: flex;
		justify-content: center;
		min-height: 1px;
		width: 100%;
	}

	.infinite-scroll__busy,
	.infinite-scroll__end,
	.infinite-scroll__error {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.infinite-scroll__error {
		color: var(--color-danger-strong);
	}
</style>
