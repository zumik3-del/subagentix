import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listRecentRootSessions } from '$lib/server/queries/sessions';
import { apiError } from '$lib/server/http';

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_OFFSET = 0;

/** Clamp `?limit=` to an integer in [1, 200], defaulting to 50. */
function parseLimit(raw: string | null): number {
	if (raw === null || raw.trim() === '') return DEFAULT_LIMIT;
	const value = Number(raw);
	if (!Number.isFinite(value)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(value)));
}

/** Clamp `?offset=` to an integer `>= 0`, defaulting to 0. */
function parseOffset(raw: string | null): number {
	if (raw === null || raw.trim() === '') return DEFAULT_OFFSET;
	const value = Number(raw);
	if (!Number.isFinite(value)) return DEFAULT_OFFSET;
	return Math.max(0, Math.trunc(value));
}

/** `GET /api/sessions?limit=&offset=&directory=&q=` -> `SessionSummary[]`. */
export const GET: RequestHandler = ({ url }) => {
	try {
		const limit = parseLimit(url.searchParams.get('limit'));
		const offset = parseOffset(url.searchParams.get('offset'));
		const directory = url.searchParams.get('directory');
		const query = url.searchParams.get('q');
		return json(
			listRecentRootSessions(limit, directory ?? undefined, offset, query ?? undefined)
		);
	} catch (cause) {
		return apiError(cause);
	}
};
