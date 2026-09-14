<script lang="ts">
	/**
	 * Tiny inline-SVG provider for the sidebar tree (task #212). Keeps the
	 * stroke paths in one place; color is inherited via `currentColor`, so the
	 * parent row controls it.
	 */
	interface Props {
		name: 'chevron' | 'folder';
		/** Chevron points down when expanded, right (−90°) when collapsed. */
		expanded?: boolean;
		size?: number;
	}

	let { name, expanded = true, size = 16 }: Props = $props();
</script>

{#if name === 'chevron'}
	<svg
		class="tree-icon tree-icon--chevron"
		class:collapsed={!expanded}
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d="M4 6.25 8 10.25 12 6.25" />
	</svg>
{:else}
	<svg
		class="tree-icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path
			d="M2.25 4.5A1.25 1.25 0 0 1 3.5 3.25h2.3c.4 0 .78.19 1.02.51l.72.96h5A1.25 1.25 0 0 1 13.79 6v5.25a1.25 1.25 0 0 1-1.25 1.25h-9A1.25 1.25 0 0 1 2.25 11.25Z"
		/>
	</svg>
{/if}

<style>
	.tree-icon {
		display: block;
		flex: none;
	}

	.tree-icon--chevron {
		transition: transform 120ms ease;
	}

	.tree-icon--chevron.collapsed {
		transform: rotate(-90deg);
	}
</style>
