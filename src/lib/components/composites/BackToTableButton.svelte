<script lang="ts">
	/**
	 * Floating "back to table" control (extracted from `NodeDetailPanel`,
	 * ADR 2.6).
	 *
	 * A fixed-position button that fades in once the Steps & actions table has
	 * scrolled out of view. Pure presentation — the visibility state and the
	 * scroll target live in `NodeActionsTable`, which passes `visible` and
	 * `onClick` down.
	 */
	import Icon from '$lib/components/primitives/Icon.svelte';

	interface Props {
		visible: boolean;
		onClick: () => void;
	}

	let { visible, onClick }: Props = $props();
</script>

<button
	type="button"
	class="ui-btn back-to-table"
	class:visible
	aria-label="Back to the Steps & actions table"
	title="Back to table"
	onclick={onClick}
>
	<Icon name="arrow-up" size={16} />
</button>

<style>
	/* Floating "back to table" control: fixed over the content, fades in
	   once the Steps & actions table has scrolled out of view. */
	.back-to-table {
		position: fixed;
		right: var(--space-4);
		bottom: var(--space-4);
		z-index: 20;
		width: var(--space-10);
		height: var(--space-10);
		padding: 0;
		border-radius: var(--radius-full);
		background: var(--surface-raised-base);
		box-shadow: var(--shadow-md);
		opacity: 0;
		transform: translateY(var(--space-2));
		pointer-events: none;
		transition:
			opacity 160ms ease,
			transform 160ms ease,
			background-color 160ms ease;
	}

	.back-to-table.visible {
		opacity: 1;
		transform: none;
		pointer-events: auto;
	}

	.back-to-table.visible:hover {
		background: var(--surface-raised-base-hover);
	}
</style>
