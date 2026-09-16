/**
 * Live row-fit measurement for the dashboard list bodies (task #444).
 *
 * Mirrors the `data.svelte.ts` split: this rune owns one `ResizeObserver` per
 * list container and the pure budget rule (`rowsThatFit`) stays in `fit.ts`,
 * testable without a DOM. Measurement is a client-only concern — the effect
 * never runs during SSR — so the first render (and hydration) still shows the
 * full list; the silent whole-row trim lands after mount.
 */
import { rowsThatFit } from './fit';

/** The container to measure plus the bounds passed to {@link rowsThatFit}. */
export interface RowFitOptions {
	/** Reactive getter for the clipped list container (a `bind:this` ref). */
	container: () => HTMLElement | null | undefined;
	/** Reactive getter for the payload's row count. */
	total: () => number;
	/** CSS selector for the first rendered row; defaults to `tbody tr`. */
	rowSelector?: string;
	/** Reactive floor on the visible row count; defaults to `0`. */
	min?: () => number;
	/** Reactive ceiling on the visible row count; defaults to `total`. */
	max?: () => number;
}

/** The visible row count a list body should render right now. */
export interface RowFit {
	/** Full list until the first client measurement, then the whole-row budget. */
	readonly budget: number;
}

/**
 * Measure a list container and its real first row with one `ResizeObserver`,
 * returning how many whole rows fit. Must be called during component
 * initialisation (it registers an `$effect`).
 */
export function useRowFit(options: RowFitOptions): RowFit {
	const { container, total, rowSelector = 'tbody tr', min = () => 0, max } = options;
	/** `null` until the first client measurement, so SSR/hydration show all rows. */
	let measured = $state<number | null>(null);

	$effect(() => {
		const element = container();
		const rows = total();
		const lower = min();
		const upper = max?.();
		if (!element) return;

		const measure = (): void => {
			const first = element.querySelector<HTMLElement>(rowSelector);
			measured = rowsThatFit({
				available: element.clientHeight,
				rowHeight: first?.getBoundingClientRect().height ?? 0,
				total: rows,
				min: lower,
				max: upper
			});
		};
		measure();

		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	});

	return {
		get budget() {
			return measured ?? total();
		}
	};
}
