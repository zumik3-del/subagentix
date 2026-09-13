<script lang="ts">
	/**
	 * Shared inline-SVG icon set (docs/ui-standards.md §7). Color inherits via
	 * `currentColor`; no emoji glyphs anywhere in the UI. `TreeIcon.svelte`
	 * stays the tree-only chevron/folder provider.
	 */
	interface Props {
		name: 'gear' | 'menu' | 'close' | 'copy' | 'check' | 'expand' | 'collapse';
		size?: number;
	}

	let { name, size = 16 }: Props = $props();
</script>

{#if name === 'gear'}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.3"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<circle cx="8" cy="8" r="2.1" />
		<path
			d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"
		/>
	</svg>
{:else if name === 'menu'}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
	</svg>
{:else if name === 'close'}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M4 4l8 8M12 4l-8 8" />
	</svg>
{:else if name === 'copy'}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.2"
		aria-hidden="true"
		focusable="false"
	>
		<rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
		<path d="M3.6 10.6A1.2 1.2 0 0 1 2.4 9.4V3.6A1.2 1.2 0 0 1 3.6 2.4h5.8a1.2 1.2 0 0 1 1.2 1.2" />
	</svg>
{:else if name === 'check'}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="currentColor"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M6.4 11.6 2.8 8l1.1-1.1 2.5 2.5 5.7-5.7L13.2 4.8z" />
	</svg>
{:else if name === 'expand'}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.4"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M9 7 13.5 2.5M13.5 2.5h-2.8M13.5 2.5v2.8" />
		<path d="M7 9 2.5 13.5M2.5 13.5h2.8M2.5 13.5v-2.8" />
	</svg>
{:else}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.4"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M13.5 2.5 9 7M9 7h2.8M9 7v-2.8" />
		<path d="M2.5 13.5 7 9M7 9h-2.8M7 9v2.8" />
	</svg>
{/if}

<style>
	.icon {
		display: block;
		flex: none;
	}
</style>
