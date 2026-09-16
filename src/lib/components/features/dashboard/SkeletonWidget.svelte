<script lang="ts">
	/**
	 * Static per-widget skeleton (dashboard Phase 3, task #404).
	 *
	 * SSR renders one of these per selected widget: the card title plus neutral
	 * placeholder bars, no data and no animation. It reuses the `.ui-card`
	 * surface primitive; the Phase 3 `WidgetHost` (task #409) replaces it with
	 * the mounted widget once it scrolls into view.
	 */
	import type { WidgetDef } from '$lib/widgets/registry';

	interface Props {
		def: WidgetDef;
	}

	let { def }: Props = $props();
</script>

<article class="skeleton-widget ui-card" aria-busy="true">
	<h2 class="skeleton-widget__title">{def.title}</h2>
	<div class="skeleton-widget__body" aria-hidden="true">
		<span class="skeleton-widget__bar"></span>
		<span class="skeleton-widget__bar"></span>
		<span class="skeleton-widget__bar skeleton-widget__bar--short"></span>
	</div>
</article>

<style>
.skeleton-widget {
	min-width: 0;
}

.skeleton-widget__title {
		margin: 0;
		font-size: var(--font-size-small);
		font-weight: var(--font-weight-medium);
		color: var(--text-weak);
	}

	.skeleton-widget__body {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.skeleton-widget__bar {
		height: var(--space-3);
		border-radius: var(--radius-sm);
		background: var(--surface-raised-base);
	}

	.skeleton-widget__bar--short {
		width: 55%;
	}
</style>
