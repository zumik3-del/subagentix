/**
 * Dashboard detail-overlay registry (dashboard widget engine, task #492).
 *
 * A detail is a modal overlay opened in place over the dashboard and addressed
 * by exactly one URL query param, so a click keeps the grid mounted, a deep
 * link restores the overlay and browser Back closes it. Adding a detail is one
 * component plus one {@link DetailDef} entry: the registry owns the URL
 * `param`, the header `title` and a co-located lazy `load` (the Vite
 * code-split boundary), while `DetailHost` owns the single mount and the
 * open/close wiring travels through {@link setDetailControls} /
 * {@link getDetailControls} instead of prop threading.
 *
 * Client-safe and SSR-safe: no `$lib/server` / DB import. The only runtime
 * dependency is Svelte's context API; `DetailHost` calls it during component
 * initialisation.
 */
import { getContext, setContext, type Component } from 'svelte';
import type { ToolCallStatus } from '$lib/model/tool-errors';
import { findWidgetDef } from '$lib/widgets/registry';

/**
 * The detail overlay a user can open, discriminated by `kind` (the registry
 * key). `tool-errors` is the failures-only view (`?toolErrors=`) and
 * `tool-calls` is the all-calls view (`?toolCalls=`); `tool`/`mode` are exactly
 * the values the detail component receives.
 */
export type DetailTarget =
	| { kind: 'tool-errors'; tool: string; mode: 'errors' }
	| { kind: 'tool-calls'; tool: string; mode: 'all' };

/** Detail kind: the registry key and the discriminant of {@link DetailTarget}. */
export type DetailKind = DetailTarget['kind'];

/**
 * A lazily imported detail component. Which props it declares is a runtime
 * pairing between `DetailHost` (it spreads the target plus the shell props) and
 * the component itself; at this boundary the prop record is intentionally
 * loose, mirroring `WidgetComponent`.
 */
export type DetailComponent = Component<any>;

/**
 * One registered detail: the URL query key that opens it, the header title and
 * a co-located dynamic `load` (Vite code-splits the target module).
 */
export interface DetailDef {
	/** URL query key; `?<param>=<tool>` opens this detail. */
	param: string;
	/** Widget title shown by the detail component's header. */
	title: string;
	/** Dynamic import of the detail component. */
	load: () => Promise<{ default: DetailComponent }>;
}

/**
 * The detail catalog, keyed by kind. Both tool-call modes render the same
 * component; only the URL param (and the mode the target carries) differ, so
 * the two deep links stay exactly `?toolErrors=<tool>` / `?toolCalls=<tool>`.
 */
export const DETAIL_DEFS: Record<DetailKind, DetailDef> = {
	'tool-errors': {
		param: 'toolErrors',
		title: findWidgetDef('top-tools').title,
		load: () => import('$lib/components/features/dashboard/ToolErrorsModal.svelte')
	},
	'tool-calls': {
		param: 'toolCalls',
		title: findWidgetDef('top-tools').title,
		load: () => import('$lib/components/features/dashboard/ToolErrorsModal.svelte')
	}
};

/**
 * URL param for the failures-only overlay (task #481, unchanged deep link).
 * Re-exported from the registry so the param name has one source.
 */
export const TOOL_ERRORS_PARAM = DETAIL_DEFS['tool-errors'].param;
/** URL param for the all-calls overlay (task #484). */
export const TOOL_CALLS_PARAM = DETAIL_DEFS['tool-calls'].param;

/** Build the tool-call overlay target for a `(tool, mode)` pair. */
export function detailTargetFor(tool: string, mode: ToolCallStatus): DetailTarget {
	return mode === 'errors'
		? { kind: 'tool-errors', tool, mode: 'errors' }
		: { kind: 'tool-calls', tool, mode: 'all' };
}

/** The open/close controls the dashboard shell provides to its descendants. */
export interface DetailControls {
	/** Open (or switch) the detail overlay for a target. */
	openDetail: (target: DetailTarget) => void;
	/** Close the currently open overlay. */
	closeDetail: () => void;
}

/** Context key; module-private so only these accessors can provide/read it. */
const DETAIL_CONTEXT = Symbol('dashboard-detail-controls');

/**
 * Provide the overlay controls to every descendant. Called once by the
 * dashboard shell during initialisation.
 */
export function setDetailControls(controls: DetailControls): void {
	setContext(DETAIL_CONTEXT, controls);
}

/**
 * Read the overlay controls; `undefined` when the component renders outside the
 * dashboard shell (e.g. a standalone widget render), so callers degrade to
 * non-interactive content instead of throwing.
 */
export function getDetailControls(): DetailControls | undefined {
	return getContext<DetailControls | undefined>(DETAIL_CONTEXT);
}
