/**
 * Pure selection logic for the dashboard widget picker (dashboard Phase 5,
 * task #414).
 *
 * Kept out of the Svelte body so the toggle/compare rules are testable without
 * a renderer or a DOM, mirroring the `top-tools.ts` helper split
 * (docs/ui-standards.md §10). No DOM, no Svelte and no `$lib/server` import.
 */
import { resolveWidgets } from '$lib/widgets/registry';
import type { WidgetId } from '$lib/widgets/registry';

/**
 * Toggle one widget in a selection and return the new array in registry order.
 * Adding an already-selected id removes it; the input is never mutated.
 */
export function toggleWidgetSelection(selected: readonly WidgetId[], id: WidgetId): WidgetId[] {
	const next = new Set(selected);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return resolveWidgets([...next]).map((def) => def.id);
}

/** Whether two selections contain the same widget ids (order/duplicates aside). */
export function sameSelection(a: readonly WidgetId[], b: readonly WidgetId[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	for (const id of b) {
		if (!set.has(id)) return false;
	}
	return true;
}
