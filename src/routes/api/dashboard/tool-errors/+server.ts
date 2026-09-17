import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	clampErrorLimit,
	clampErrorOffset,
	DEFAULT_ERROR_LIMIT,
	type ToolErrorsQuery
} from '$lib/model/tool-errors';
import { getToolErrors } from '$lib/server/services/dashboard-tool-errors';
import { resolveFilter } from '../widgets';

/** Detail data is per-request state; never cached. */
const NO_STORE = 'no-store';

/** Clamp `?limit=`; an absent/non-finite value falls back to the page default. */
function parseLimit(raw: string | null): number {
	if (raw === null || raw.trim() === '') return DEFAULT_ERROR_LIMIT;
	const value = Number(raw);
	return clampErrorLimit(Number.isFinite(value) ? value : DEFAULT_ERROR_LIMIT);
}

/** Clamp `?offset=`; an absent/non-finite value falls back to `0`. */
function parseOffset(raw: string | null): number {
	if (raw === null || raw.trim() === '') return 0;
	const value = Number(raw);
	return clampErrorOffset(Number.isFinite(value) ? value : 0);
}

/**
 * `GET /api/dashboard/tool-errors?period=&scope=&tool=&agent=&q=&limit=&offset=`
 * -> `{ rows, total, agents, capped }`.
 *
 * The top-tools error detail: one page of failed tool calls (newest first) plus
 * the filtered total, the stable agent options and the Tier-P `capped` flag. An
 * invalid period/scope is the same 400 `{ error, field }` as `/api/dashboard`;
 * a data-layer failure is a generic 500 that never leaks internals (`apiError`
 * would echo them, so it is deliberately not used here). Never cached.
 */
export const GET: RequestHandler = ({ url }) => {
	try {
		const resolved = resolveFilter(url);
		if (!resolved.ok) {
			resolved.response.headers.set('cache-control', NO_STORE);
			return resolved.response;
		}
		const query: ToolErrorsQuery = {
			tool: url.searchParams.get('tool'),
			agent: url.searchParams.get('agent'),
			search: url.searchParams.get('q'),
			limit: parseLimit(url.searchParams.get('limit')),
			offset: parseOffset(url.searchParams.get('offset'))
		};
		const response = json(getToolErrors(resolved.filter, query));
		response.headers.set('cache-control', NO_STORE);
		return response;
	} catch (cause) {
		console.error('[api/dashboard/tool-errors] load failed:', cause);
		return json(
			{ error: 'Failed to load dashboard data.' },
			{ status: 500, headers: { 'cache-control': NO_STORE } }
		);
	}
};
