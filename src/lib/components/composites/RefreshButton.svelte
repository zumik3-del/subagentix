<script lang="ts">
	/**
	 * The one refresh/reload control in the UI (docs/ui-standards.md §10).
	 *
	 * It exists as a component — not a `.ui-*` class — because the behaviour is
	 * repeated verbatim at every call site (class-vs-component rule, §6): two
	 * variants (icon-only circular when `label` is omitted, labelled `.ui-btn`
	 * otherwise) plus the one-shot spin feedback. Call sites own the fetching
	 * and pass `disabled` for their own in-flight state.
	 *
	 * The spin is deliberately NOT a loading spinner: it turns once per click and
	 * stops. A fetch that outlasts the animation must not keep the glyph moving,
	 * otherwise a slow request reads as an endless loop. `disabled` is the
	 * in-flight signal.
	 */
	import Icon, { ICON_SIZE } from '$lib/components/primitives/Icon.svelte';

	interface Props {
		/** Called on click; the button owns no fetching of its own. */
		onclick: () => void;
		/** Accessible name (always required — the icon-only variant has no text). */
		ariaLabel: string;
		/** Visible text; omit for the icon-only circular control. */
		label?: string;
		title?: string;
		disabled?: boolean;
	}

	/**
	 * Spin length plus the timer that clears the rotation. `animationend` is the
	 * primary signal, but it never fires for a reduced-motion user (the
	 * `prefers-reduced-motion` off-rule in app.css) nor when the button unmounts
	 * mid-spin, so the timer is the guarantee the attribute is always cleared.
	 */
	const SPIN_MS = 700;

	let { onclick, ariaLabel, label, title, disabled = false }: Props = $props();
	let rotating = $state(false);
	let spinTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => () => clearTimeout(spinTimer));

	function handleClick(): void {
		rotating = true;
		onclick();
		clearTimeout(spinTimer);
		spinTimer = setTimeout(() => {
			rotating = false;
		}, SPIN_MS);
	}

	function stopSpin(): void {
		clearTimeout(spinTimer);
		rotating = false;
	}

	const iconSize = $derived(label === undefined ? ICON_SIZE.md : ICON_SIZE.sm);
</script>

<button
	type="button"
	class={label === undefined ? 'ui-icon-btn ui-icon-btn--circle' : 'ui-btn'}
	aria-label={ariaLabel}
	{title}
	{disabled}
	data-rotate={rotating ? '' : undefined}
	onclick={handleClick}
	onanimationend={stopSpin}
>
	<Icon name="refresh" size={iconSize} />{#if label !== undefined}{label}{/if}
</button>
