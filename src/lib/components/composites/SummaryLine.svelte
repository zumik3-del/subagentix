<script lang="ts">
	/**
	 * One summary line (extracted from `NodeDetailPanel`, ADR 2.2).
	 *
	 * Owns the single-line `.line` row, the absolutely-positioned `+N ещё`
	 * overflow counter and the `clampLine` measurement action. The caller
	 * supplies the line label, the empty placeholder and the item list through
	 * the default snippet, and flags `overflow` when that snippet renders
	 * `data-overflow-item` entries so the counter is present. Pure
	 * presentation — `signal` retriggers the re-measure (the panel passes the
	 * node detail object, keeping the height stable when switching nodes).
	 *
	 * The template keeps `{@render children()}` and the counter on one line
	 * (with an explicit `{' '}`) so the emitted whitespace around the counter
	 * matches the original panel markup exactly.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		/** Re-measure trigger: the line is re-clamped whenever this changes. */
		signal: unknown;
		/** Whether the snippet renders overflow items (so the counter is present). */
		overflow?: boolean;
		/**
		 * Whether the line clips its content to one line (default). A column
		 * hosting an escaping popover (the tracker refs dropdown) opts out so
		 * the popover is not clipped.
		 */
		clip?: boolean;
		children: Snippet;
	}

	let { signal, overflow = false, clip = true, children }: Props = $props();

	/**
	 * Keep a summary row exactly one line tall: items that no longer fit are
	 * covered by an absolutely-positioned "+N ещё" counter whose tooltip lists
	 * them. Re-measured on resize and whenever `signal` (the node detail)
	 * changes, so the panel height stays stable when switching nodes.
	 */
	function clampLine(node: HTMLElement, signal: unknown) {
		void signal;
		let frame = 0;
		const measure = () => {
			frame = 0;
			const counter = node.querySelector<HTMLElement>('[data-overflow-counter]');
			const items = Array.from(node.querySelectorAll<HTMLElement>('[data-overflow-item]'));
			if (!counter || items.length === 0) return;
			const right = node.getBoundingClientRect().right;
			let visible = items.length;
			for (let i = 0; i < items.length; i++) {
				if (items[i].getBoundingClientRect().right > right + 0.5) {
					visible = i;
					break;
				}
			}
			if (visible >= items.length) {
				counter.hidden = true;
				return;
			}
			const limit = right - (counter.offsetWidth || 64) - 4;
			let fit = 0;
			for (let i = 0; i < items.length; i++) {
				if (items[i].getBoundingClientRect().right <= limit) fit++;
				else break;
			}
			const hidden = items.length - fit;
			if (hidden <= 0) {
				counter.hidden = true;
				return;
			}
			counter.hidden = false;
			counter.textContent = `+${hidden} ещё`;
			counter.title = items
				.slice(fit)
				.map((el) => el.textContent?.trim() ?? '')
				.filter(Boolean)
				.join('\n');
		};
		const schedule = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		};
		schedule();
		const observer = new ResizeObserver(schedule);
		observer.observe(node);
		return {
			update: schedule,
			destroy() {
				if (frame) cancelAnimationFrame(frame);
				observer.disconnect();
			}
		};
	}
</script>

<div class="line" class:line--unclipped={!clip} use:clampLine={signal}>{@render children()}{#if overflow}{' '}<span
			class="line-more"
			data-overflow-counter
			hidden
		></span>{/if}</div>

<style>
	/* A summary row clipped to a single line: the section label sits inline
	   at the start, then the items; overflow is covered by the absolutely
	   positioned `.line-more` counter. */
	.line {
		position: relative;
		display: flex;
		flex-wrap: nowrap;
		align-items: baseline;
		gap: var(--space-2);
		overflow: hidden;
		min-height: var(--space-6);
	}

	.line--unclipped {
		overflow: visible;
	}

	.line-more {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		display: inline-flex;
		align-items: center;
		padding-left: var(--space-2);
		background: var(--background-strong);
		color: var(--text-interactive-base);
		font-size: var(--font-size-small);
	}

	.line-more[hidden] {
		display: none;
	}
</style>
