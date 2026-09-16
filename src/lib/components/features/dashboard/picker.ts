/**
 * Pure placement logic for the dashboard widget picker (dashboard Phase 5,
 * task #414; resizable in #438).
 *
 * Kept out of the Svelte body so the toggle/compare/size rules are testable
 * without a renderer or a DOM, mirroring the `top-tools.ts` helper split
 * (docs/ui-standards.md §10). No DOM, no Svelte and no `$lib/server` import.
 */
import { resolvePlacements } from '$lib/widgets/registry';
import type { WidgetId, WidgetPlacement } from '$lib/widgets/registry';

/**
 * Toggle one widget in a placement selection and return the new array in
 * registry order. Adding an already-selected id removes it; a newly added id
 * starts from its registry-default size; existing sizes are preserved. The
 * input is never mutated.
 */
export function toggleWidgetSelection(
	selected: readonly WidgetPlacement[],
	id: WidgetId
): WidgetPlacement[] {
	const next = new Map(selected.map((placement) => [placement.id, placement] as const));
	if (next.has(id)) next.delete(id);
	else next.set(id, resolvePlacements([id])[0]);
	return resolvePlacements([...next.values()]);
}

/** Apply a width/height patch to one placement, keeping registry order. */
export function updatePlacement(
	selected: readonly WidgetPlacement[],
	id: WidgetId,
	patch: Partial<Pick<WidgetPlacement, 'width' | 'height'>>
): WidgetPlacement[] {
	return resolvePlacements(
		selected.map((placement) =>
			placement.id === id ? { ...placement, ...patch } : placement
		)
	);
}

/**
 * Whether two placement selections contain the same widgets at the same sizes
 * (input order/duplicates aside). Drives the modal's dirty state, so a
 * size-only change counts as dirty.
 */
export function samePlacements(
	a: readonly WidgetPlacement[],
	b: readonly WidgetPlacement[]
): boolean {
	if (a.length !== b.length) return false;
	const byId = new Map(a.map((placement) => [placement.id, placement] as const));
	for (const placement of b) {
		const other = byId.get(placement.id);
		if (!other || other.width !== placement.width || other.height !== placement.height) {
			return false;
		}
	}
	return true;
}
