<script lang="ts">
	/**
	 * App shell (task U1): a full-viewport two-column layout — a sticky session
	 * sidebar and a content area that fills the remaining width/height. There is
	 * no centered `max-width` container; pages decide their own inner spacing.
	 *
	 * Below the `--breakpoint-lg` (64rem) the sidebar becomes an overlay toggled
	 * by the button in the content area, so the main content stays usable.
	 */
	import '../app.css';
	import { onMount } from 'svelte';
	import SessionSidebar from '$lib/components/features/sidebar/SessionSidebar.svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';
	import SettingsModal from '$lib/components/features/settings/SettingsModal.svelte';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import { initBrowserTimeZone } from '$lib/model/clock.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	let sidebarOpen = $state(false);
	let settingsOpen = $state(false);

	// Swap timestamps to the visitor's zone after hydration; SSR keeps the UTC
	// default, so the first client render still matches the server DOM.
	onMount(() => initBrowserTimeZone());

	// Off-canvas focus management (U2 review): on narrow viewports the closed
	// panel is hidden via CSS (`visibility: hidden`), which removes it from the
	// tab order; opening moves focus into the panel and closing restores it to
	// the toggle. `$effect` only runs in the browser, so SSR is unaffected.
	let sidebarSlot = $state<HTMLDivElement | null>(null);
	let toggleButton = $state<HTMLButtonElement | null>(null);
	let previouslyOpen = false;

	function narrowViewport(): boolean {
		return typeof window !== 'undefined' && window.matchMedia('(max-width: 63.99rem)').matches;
	}

	$effect(() => {
		const open = sidebarOpen;
		const wasOpen = previouslyOpen;
		previouslyOpen = open;
		if (!narrowViewport()) return;
		if (open && !wasOpen) {
			sidebarSlot
				?.querySelector<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
				?.focus();
		} else if (!open && wasOpen) {
			toggleButton?.focus();
		}
	});
</script>

<div class="shell" class:sidebar-open={sidebarOpen} inert={settingsOpen}>
	<div class="sidebar-slot" bind:this={sidebarSlot}>
		<SessionSidebar
			initial={data.sidebar}
			onNavigate={() => (sidebarOpen = false)}
			onOpenSettings={() => (settingsOpen = true)}
			settingsOpen={settingsOpen}
		/>
	</div>

	<div class="content">
		<ScrollView>
			<button
				type="button"
				class="ui-btn sidebar-toggle"
				bind:this={toggleButton}
				aria-expanded={sidebarOpen}
				aria-controls="session-sidebar"
				onclick={() => (sidebarOpen = !sidebarOpen)}
			>
				<Icon name="menu" /> Sessions
			</button>
			{@render children()}
		</ScrollView>
	</div>

	{#if sidebarOpen}
		<button
			type="button"
			class="sidebar-backdrop"
			aria-label="Close session navigator"
			onclick={() => (sidebarOpen = false)}
		></button>
	{/if}
</div>

<SettingsModal open={settingsOpen} onClose={() => (settingsOpen = false)} />

<style>
	.shell {
		display: grid;
		grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
		height: 100dvh;
		min-height: 100dvh;
	}

	.sidebar-slot {
		display: flex;
		flex-direction: column;
		position: sticky;
		top: 0;
		height: 100dvh;
		overflow: hidden;
		border-right: 1px solid var(--border-weak-base);
		background: var(--background-strong);
	}

	/*
	 * The content column bounds the app's vertical scroll region. The actual
	 * scrolling (and its overlay thumb) lives in the inner `ScrollView`
	 * viewport, so this column only needs to clamp the height and let the
	 * scroll view fill it. `position: sticky` on the inspector and the narrow
	 * toggle resolves against the `ScrollView` scrollport.
	 */
	.content {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.sidebar-toggle {
		display: none;
	}

	.sidebar-backdrop {
		display: none;
	}

	@media (max-width: 63.99rem) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
		}

		.sidebar-slot {
			position: fixed;
			top: 0;
			bottom: 0;
			left: 0;
			width: min(85vw, var(--sidebar-width));
			height: 100dvh;
			z-index: 30;
			transform: translateX(-100%);
			visibility: hidden;
			transition:
				transform 0.18s ease,
				visibility 0.18s;
		}

		.shell.sidebar-open .sidebar-slot {
			transform: translateX(0);
			visibility: visible;
			box-shadow: var(--shadow-lg);
		}

		.sidebar-toggle {
			display: inline-flex;
			align-items: center;
			gap: var(--space-1);
			position: sticky;
			top: var(--space-3);
			z-index: 20;
			margin: var(--space-3) 0 0 var(--space-3);
		}

		.sidebar-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 25;
			border: 0;
			padding: 0;
			background: rgba(0, 0, 0, 0.5);
			cursor: pointer;
		}
	}
</style>
