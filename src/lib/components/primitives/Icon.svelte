<script module lang="ts">
	/**
	 * Named icon sizes in px. Composites pass these instead of bare numbers so
	 * a size stays a decision of the primitive set, not of each call site
	 * (docs/ui-standards.md §7).
	 */
	export const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 28 } as const;
</script>

<script lang="ts">
	/**
	 * Shared inline-SVG icon set (docs/ui-standards.md §7). Color inherits via
	 * `currentColor`; no emoji glyphs anywhere in the UI. `TreeIcon.svelte`
	 * stays the tree-only chevron/folder provider.
	 */
	interface Props {
		name:
			| 'gear'
			| 'menu'
			| 'close'
			| 'copy'
			| 'check'
			| 'expand'
			| 'collapse'
			| 'arrow-up'
			| 'refresh'
			| 'files';
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
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<!-- Standard Lucide/Feather `settings` cog, authored on the 24-unit grid
		     and scaled into the shared 16-unit viewBox; `stroke-width` lives on
		     the group so the 2-unit pen scales to an effective 1.33. -->
		<g transform="scale(0.666667)" stroke-width="2">
			<path
				d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
			/>
			<circle cx="12" cy="12" r="3" />
		</g>
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
{:else if name === 'arrow-up'}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" />
	</svg>
{:else if name === 'refresh'}
	<svg
		class="icon"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="currentColor"
		stroke="none"
		aria-hidden="true"
		focusable="false"
	>
		<!-- Remix `refresh` glyph: a filled 24-unit path, not a Lucide-style
		     stroke, so it is authored and scaled on its own grid. Shared by
		     every refresh control through `RefreshButton` (task #1146). -->
		<path
			d="M5.46257 4.43262C7.21556 2.91688 9.5007 2 12 2C17.5228 2 22 6.47715 22 12C22 14.1361 21.3302 16.1158 20.1892 17.7406L17 12H20C20 7.58172 16.4183 4 12 4C9.84982 4 7.89777 4.84827 6.46023 6.22842L5.46257 4.43262ZM18.5374 19.5674C16.7844 21.0831 14.4993 22 12 22C6.47715 22 2 17.5228 2 12C2 9.86386 2.66979 7.88416 3.8108 6.25944L7 12H4C4 16.4183 7.58172 20 12 20C14.1502 20 16.1022 19.1517 17.5398 17.7716L18.5374 19.5674Z"
		/>
	</svg>
{:else if name === 'files'}
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
		<path d="M3.5 1.5h5.25L12.5 5.25v9.25a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z" />
		<path d="M8.75 1.5v3.75h3.75" />
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
