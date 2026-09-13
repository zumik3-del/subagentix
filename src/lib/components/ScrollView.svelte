<script lang="ts">
	/**
	 * Overlay scrollbars (task #225), mirroring opencode's `scroll-view`.
	 *
	 * Renders a flex wrapper with a scrollable viewport whose native scrollbar is
	 * hidden (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`),
	 * plus one absolutely-positioned thumb per scrollable axis. The thumb is shown
	 * while dragging, for 800ms after the last scroll, and while the pointer hovers
	 * the region (`thumbVisibility`). Colours come from the neutral
	 * `--border-weak-base` / `--border-strong-base` tokens (never a blue accent).
	 *
	 * Svelte 5 runes only — no dependencies, no raw HTML injection. Pure client
	 * behaviour is confined to `$effect` so SSR renders just the wrapper +
	 * viewport + children.
	 */
	import type { Snippet } from 'svelte';
	import { onDestroy } from 'svelte';

	type Orientation = 'vertical' | 'horizontal' | 'both';
	type ThumbVisibility = 'hover' | 'scroll' | 'always';

	interface Props {
		children: Snippet;
		/** Which axes can scroll; thumb(s) are rendered per overflowing axis. */
		orientation?: Orientation;
		/** `hover` (default) shows on hover/scroll/drag; `scroll` on scroll/drag; `always`. */
		thumbVisibility?: ThumbVisibility;
		class?: string;
		/** Measured viewport width in px (bindable) for layout consumers. */
		viewportWidth?: number;
		/** Measured viewport height in px (bindable) for layout consumers. */
		viewportHeight?: number;
	}

	let {
		children,
		orientation = 'vertical',
		thumbVisibility = 'hover',
		class: className = '',
		viewportWidth = $bindable(0),
		viewportHeight = $bindable(0)
	}: Props = $props();

	// Track padding matches opencode's 8px inset; a thumb never shrinks below this.
	const PADDING = 8;
	const MIN_THUMB = 32;
	const SCROLL_HIDE_MS = 800;

	const vertical = $derived(orientation === 'vertical' || orientation === 'both');
	const horizontal = $derived(orientation === 'horizontal' || orientation === 'both');

	let viewportEl = $state<HTMLDivElement | null>(null);
	let isHovered = $state(false);
	let isDragging = $state(false);
	let dragAxis = $state<'vertical' | 'horizontal' | null>(null);
	let isScrolling = $state(false);
	let showVertical = $state(false);
	let showHorizontal = $state(false);
	let verticalLength = $state(0);
	let verticalOffset = $state(0);
	let horizontalLength = $state(0);
	let horizontalOffset = $state(0);

	let scrollTimer: ReturnType<typeof setTimeout> | undefined;
	let measureFrame: number | undefined;

	const thumbVisible = $derived(
		thumbVisibility === 'always' ||
			isDragging ||
			isScrolling ||
			(thumbVisibility === 'hover' && isHovered)
	);

	function clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}

	/** Thumb length/offset for one axis, proportional to content vs viewport. */
	function axisMetrics(position: number, content: number, viewport: number) {
		const track = Math.max(0, viewport - PADDING * 2);
		const length = Math.max(0, Math.min(track, Math.max((viewport / content) * track, MIN_THUMB)));
		const travel = Math.max(0, track - length);
		const range = content - viewport;
		const offset =
			PADDING + (range > 0 && travel > 0 ? clamp((position / range) * travel, 0, travel) : 0);
		return { length, offset };
	}

	/** Thumb scroll position as a 0–100 value for the ARIA slider (see template). */
	function thumbPercent(offset: number, length: number, viewport: number): number {
		const travel = Math.max(0, viewport - PADDING * 2 - length);
		if (travel <= 0) return 0;
		return Math.round((clamp(offset - PADDING, 0, travel) / travel) * 100);
	}

	/** Recompute viewport size (exposed to the parent) and both thumb metrics. */
	function measure() {
		const el = viewportEl;
		if (!el) return;
		viewportWidth = el.clientWidth;
		viewportHeight = el.clientHeight;

		if (vertical && el.clientHeight > 0 && el.scrollHeight > el.clientHeight) {
			const { length, offset } = axisMetrics(el.scrollTop, el.scrollHeight, el.clientHeight);
			showVertical = true;
			verticalLength = length;
			verticalOffset = offset;
		} else {
			showVertical = false;
		}

		if (horizontal && el.clientWidth > 0 && el.scrollWidth > el.clientWidth) {
			const { length, offset } = axisMetrics(el.scrollLeft, el.scrollWidth, el.clientWidth);
			showHorizontal = true;
			horizontalLength = length;
			horizontalOffset = offset;
		} else {
			showHorizontal = false;
		}
	}

	function markScrolling() {
		isScrolling = true;
		if (scrollTimer !== undefined) clearTimeout(scrollTimer);
		scrollTimer = setTimeout(() => {
			isScrolling = false;
		}, SCROLL_HIDE_MS);
	}

	function onScroll() {
		measure();
		markScrolling();
	}

	// Observers fire in bursts (layout + content mutations); coalesce them into
	// one measurement per frame so a text edit never forces a read per mutation.
	function scheduleMeasure() {
		if (measureFrame !== undefined) return;
		measureFrame = requestAnimationFrame(() => {
			measureFrame = undefined;
			measure();
		});
	}

	// ResizeObserver keeps the thumb in sync with viewport/content size; the
	// MutationObserver catches content edits that do not change the box size
	// (e.g. swapped text inside a max-height `<div>` with no wrapper element).
	$effect(() => {
		const el = viewportEl;
		if (!el) return;
		const resizeObserver = new ResizeObserver(scheduleMeasure);
		resizeObserver.observe(el);
		const content = el.firstElementChild;
		if (content) resizeObserver.observe(content);
		const mutationObserver = new MutationObserver(scheduleMeasure);
		mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });
		measure();
		return () => {
			resizeObserver.disconnect();
			mutationObserver.disconnect();
		};
	});

	onDestroy(() => {
		if (scrollTimer !== undefined) clearTimeout(scrollTimer);
		if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
	});

	function startDrag(event: PointerEvent, axis: 'vertical' | 'horizontal') {
		const el = viewportEl;
		const target = event.currentTarget as HTMLElement | null;
		if (!el || !target) return;
		event.preventDefault();
		event.stopPropagation();
		isDragging = true;
		dragAxis = axis;

		const rect = target.getBoundingClientRect();
		const grabOffset = axis === 'vertical' ? event.clientY - rect.top : event.clientX - rect.left;
		target.setPointerCapture(event.pointerId);

		const move = (moveEvent: PointerEvent) => {
			const viewportRect = el.getBoundingClientRect();
			if (axis === 'vertical') {
				const track = Math.max(0, el.clientHeight - PADDING * 2);
				const travel = Math.max(0, track - verticalLength);
				if (travel <= 0) return;
				const position = clamp(
					moveEvent.clientY - viewportRect.top - PADDING - grabOffset,
					0,
					travel
				);
				el.scrollTop = (position / travel) * Math.max(0, el.scrollHeight - el.clientHeight);
			} else {
				const track = Math.max(0, el.clientWidth - PADDING * 2);
				const travel = Math.max(0, track - horizontalLength);
				if (travel <= 0) return;
				const position = clamp(moveEvent.clientX - viewportRect.left - PADDING - grabOffset, 0, travel);
				el.scrollLeft = (position / travel) * Math.max(0, el.scrollWidth - el.clientWidth);
			}
		};

		const end = (endEvent: PointerEvent) => {
			isDragging = false;
			dragAxis = null;
			if (target.hasPointerCapture(endEvent.pointerId)) {
				target.releasePointerCapture(endEvent.pointerId);
			}
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', end);
			target.removeEventListener('pointercancel', end);
		};

		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', end);
		target.addEventListener('pointercancel', end);
	}
</script>

<div
	class={`scroll-view ${className}`}
	role="group"
	onpointerenter={() => (isHovered = true)}
	onpointerleave={() => (isHovered = false)}
>
	<div
		class={`scroll-view__viewport scroll-view__viewport--${orientation}`}
		bind:this={viewportEl}
		onscroll={onScroll}
		onwheel={markScrolling}
	>
		{@render children()}
	</div>

	{#if vertical && showVertical}
		<div
			class="scroll-view__thumb scroll-view__thumb--vertical"
			role="slider"
			tabindex="-1"
			aria-label="Vertical scrollbar"
			aria-orientation="vertical"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={thumbPercent(verticalOffset, verticalLength, viewportHeight)}
			data-visible={thumbVisible}
			data-dragging={isDragging && dragAxis === 'vertical'}
			style={`height:${verticalLength}px;transform:translateY(${verticalOffset}px)`}
			onpointerdown={(event) => startDrag(event, 'vertical')}
		></div>
	{/if}

	{#if horizontal && showHorizontal}
		<div
			class="scroll-view__thumb scroll-view__thumb--horizontal"
			role="slider"
			tabindex="-1"
			aria-label="Horizontal scrollbar"
			aria-orientation="horizontal"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={thumbPercent(horizontalOffset, horizontalLength, viewportWidth)}
			data-visible={thumbVisible}
			data-dragging={isDragging && dragAxis === 'horizontal'}
			style={`width:${horizontalLength}px;transform:translateX(${horizontalOffset}px)`}
			onpointerdown={(event) => startDrag(event, 'horizontal')}
		></div>
	{/if}
</div>

<style>
	.scroll-view {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.scroll-view__viewport {
		flex: auto;
		width: 100%;
		min-height: 0;
		outline: none;
		scrollbar-width: none;
	}

	.scroll-view__viewport--vertical {
		overflow-x: hidden;
		overflow-y: auto;
	}

	.scroll-view__viewport--horizontal {
		overflow-x: auto;
		overflow-y: hidden;
	}

	.scroll-view__viewport--both {
		overflow: auto;
	}

	.scroll-view__viewport::-webkit-scrollbar {
		display: none;
	}

	.scroll-view__thumb {
		position: absolute;
		pointer-events: auto;
		cursor: default;
		opacity: 0;
		transition: opacity 0.2s;
		-webkit-user-select: none;
		user-select: none;
	}

	.scroll-view__thumb[data-visible='true'] {
		opacity: 1;
	}

	.scroll-view__thumb--vertical {
		top: 0;
		inset-inline-end: 0;
		width: 12px;
	}

	.scroll-view__thumb--horizontal {
		bottom: 0;
		left: 0;
		height: 12px;
	}

	.scroll-view__thumb:after {
		content: '';
		position: absolute;
		background-color: var(--border-weak-base);
		-webkit-backdrop-filter: blur(4px);
		backdrop-filter: blur(4px);
		border-radius: 9999px;
		transition: background-color 0.15s;
	}

	.scroll-view__thumb--vertical:after {
		top: 0;
		bottom: 0;
		left: 50%;
		width: 4px;
		transform: translateX(-50%);
	}

	.scroll-view__thumb--horizontal:after {
		left: 0;
		right: 0;
		top: 50%;
		height: 4px;
		transform: translateY(-50%);
	}

	.scroll-view__thumb:hover:after,
	.scroll-view__thumb[data-dragging='true']:after {
		background-color: var(--border-strong-base);
	}
</style>
