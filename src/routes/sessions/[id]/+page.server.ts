import { error, isHttpError } from '@sveltejs/kit';
import { getAgentColors } from '$lib/server/agent-colors';
import { resolveZiptaskBaseUrl, resolveZiptaskEnabled } from '$lib/server/settings';
import { getSessionDetail } from '$lib/server/services/sessions';
import { buildTurnOutline } from '$lib/server/services/turn/outline';
import { DEFAULT_TURN_WINDOW, windowTurns } from '$lib/model/paging';
import type { GanttOutline } from '$lib/model/types';
import type { PageServerLoad } from './$types';

/** Parse `?turnStart=` (0-based window start); `null` => anchor at the last page. */
function parseTurnStart(raw: string | null): number | null {
	if (raw === null || raw.trim() === '') return null;
	const value = Number(raw);
	if (!Number.isFinite(value)) return null;
	return Math.max(0, Math.trunc(value));
}

/**
 * Deferred Gantt build (task #385). Returning a promise lets the page shell
 * (header + turn context) stream before the turn build finishes, so SSR never
 * blocks on it; `+page.svelte` awaits it with a skeleton. The build is deferred
 * to a microtask so the loader returns before it starts, and `buildTurnOutline`
 * stays the single source of the lightweight payload (Phase 4 / task #387): the
 * heavy per-node detail is fetched lazily by the Gantt. An unexpected build
 * failure rejects the promise and surfaces through the page's error state.
 */
function buildGantt(rootSessionId: string, turnId: string): Promise<GanttOutline> {
	return Promise.resolve().then(() => {
		const outline = buildTurnOutline(rootSessionId, turnId);
		if (!outline) throw error(404, `Unknown turn "${turnId}" for session "${rootSessionId}".`);
		return outline;
	});
}

export const load: PageServerLoad = ({ params, url }) => {
	try {
		const detail = getSessionDetail(params.id);
		if (!detail) throw error(404, `Unknown session "${params.id}".`);

		// The Gantt model is server-only (queries the DB); the client only ever
		// receives the serializable DTO. `url` is always set by the framework;
		// the guard keeps direct loader calls (tests) working without a query.
		const turnId = url ? url.searchParams.get('turn') : null;
		// Inferred ziptask chips open the task modal (server-proxied); never a
		// hardcoded host. The integration toggle gates the whole feature, so a
		// disabled integration passes no base and the Gantt/panel render no
		// tracker UI at all.
		const ziptaskEnabled = resolveZiptaskEnabled();
		const ziptaskBaseUrl = ziptaskEnabled ? resolveZiptaskBaseUrl() : null;

		// The full turn list stays behind the window: only a bounded slice is
		// rendered. An explicit `?turnStart=` is authoritative (so the Older/
		// Newer links keep advancing); the window grows up to 2x to still show
		// the selected `?turn=` when it fits (M4b).
		const turnWindow = windowTurns(
			detail.turns,
			turnId,
			url ? parseTurnStart(url.searchParams.get('turnStart')) : null,
			DEFAULT_TURN_WINDOW,
			{ honorRequestedStart: true }
		);
		const page = {
			...detail,
			turns: turnWindow.turns,
			turnWindow,
			ziptaskEnabled,
			ziptaskBaseUrl,
			// Per-agent node swatch colors from the opencode agent md frontmatter
			// (task #239); `{}` when the config dir is missing.
			agentColors: getAgentColors()
		};

		if (turnId === null) return { ...page, gantt: null };

		// An unknown turn still answers 404 synchronously: the trigger must be one
		// of the root session's user messages (`detail.turns`), which is exactly
		// the precondition `buildTurnModel` checks — no model work needed here.
		// Keeping this check on the shell response means a bad `?turn=` keeps its
		// HTTP 404 even though the model itself is streamed.
		if (!detail.turns.some((turn) => turn.turnId === turnId)) {
			throw error(404, `Unknown turn "${turnId}" for session "${params.id}".`);
		}
		return { ...page, gantt: buildGantt(params.id, turnId) };
	} catch (cause) {
		if (isHttpError(cause)) throw cause;
		// Surface the data layer's read-only/WAL error verbatim (ADR §4.5, R2).
		throw error(503, cause instanceof Error ? cause.message : String(cause));
	}
};
