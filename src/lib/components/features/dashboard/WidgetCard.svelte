<script lang="ts">
	/**
	 * Dashboard widget card (dashboard Phase 3, task #409).
	 *
	 * The shared chrome every widget body renders on top of the `.ui-card`
	 * primitive (task #409): title row, optional refresh control, and the
	 * standard loading / empty / error states. Data lifecycle belongs to the
	 * caller (`useWidgetData`, task #410) — this component is presentation-only
	 * and renders `children` when `status` is `ready`.
	 */
	import type { Snippet } from 'svelte';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import type { WidgetStatus } from './widget';

	interface Props {
		/** Card title (registry `WidgetDef.title`). */
		title: string;
		/** Body lifecycle state; only `ready` renders `children`. */
		status?: WidgetStatus;
		/** Message for the `error` state. */
		error?: string;
		/** Disables the refresh control while a refresh is in flight. */
		refreshing?: boolean;
		/** Refresh callback; when omitted no refresh control renders. */
		onRefresh?: () => void;
		/** Widget body, rendered when `status === 'ready'`. */
		children?: Snippet;
	}

	let {
		title,
		status = 'ready',
		error,
		refreshing = false,
		onRefresh,
		children
	}: Props = $props();
</script>

<article class="ui-card widget-card" aria-busy={status === 'loading'}>
	<header class="widget-card__head">
		<h2 class="widget-card__title">{title}</h2>
		{#if onRefresh}
			<button
				class="ui-icon-btn widget-card__refresh"
				class:is-spinning={refreshing || status === 'loading'}
				type="button"
				onclick={onRefresh}
				disabled={refreshing || status === 'loading'}
				aria-label="Refresh {title}"
				title="Refresh"
			>
				<Icon name="refresh" />
			</button>
		{/if}
	</header>

	<div class="widget-card__body">
		{#if status === 'loading'}
			<div class="widget-card__placeholder" aria-hidden="true">
				<span class="widget-card__bar"></span>
				<span class="widget-card__bar widget-card__bar--short"></span>
			</div>
			<p class="sr-only" role="status">Loading {title}…</p>
		{:else if status === 'error'}
			<p class="widget-card__message widget-card__message--error" role="alert">
				{error ?? 'Something went wrong.'}
			</p>
			{#if onRefresh}
				<button class="ui-btn widget-card__retry" type="button" onclick={onRefresh}>Retry</button>
			{/if}
		{:else if status === 'empty'}
			<p class="widget-card__message">No data for this period.</p>
		{:else}
			{@render children?.()}
		{/if}
	</div>
</article>

<style>
	.widget-card {
		/* Stretch to the grid cell assigned by `WidgetGrid` (task #438). */
		height: 100%;
		min-width: 0;
	}

	.widget-card__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		min-height: var(--space-6);
	}

	.widget-card__title {
		margin: 0;
		font-size: var(--font-size-small);
		font-weight: var(--font-weight-medium);
		color: var(--text-weak);
	}

	.widget-card__body {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: var(--space-3);
		min-height: 0;
		min-width: 0;
	}

	/* Refresh control feedback while a fetch is in flight (task #438): CSS-only
	   keyframes, no JS timer; suppressed for reduced-motion users. */
	.widget-card__refresh.is-spinning :global(svg) {
		animation: widget-refresh-spin 1s linear infinite;
	}

	@keyframes widget-refresh-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.widget-card__refresh.is-spinning :global(svg) {
			animation: none;
		}
	}

	.widget-card__placeholder {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.widget-card__bar {
		height: var(--space-3);
		border-radius: var(--radius-sm);
		background: var(--surface-raised-base);
	}

	.widget-card__bar--short {
		width: 55%;
	}

	.widget-card__message {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.widget-card__message--error {
		color: var(--color-danger-strong);
	}

	.widget-card__retry {
		align-self: flex-start;
	}
</style>
