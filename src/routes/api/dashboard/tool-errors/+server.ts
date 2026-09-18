import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	clampErrorLimit,
	clampErrorOffset,
	DEFAULT_ERROR_LIMIT,
	DEFAULT_TOOL_CALL_STATUS,
	isToolCallStatus,
	type ToolCallStatus,
	type ToolErrorsQuery
} from '$lib/model/tool-errors';
import { invalidRequest } from '$lib/server/http';
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

/** `?status=`: absent/blank = the default (`errors`), unknown = `null` (a 400). */
function parseStatus(raw: string | null): ToolCallStatus | null {
	if (raw === null || raw.trim() === '') return DEFAULT_TOOL_CALL_STATUS;
	return isToolCallStatus(raw) ? raw : null;
}

/**
 * `GET /api/dashboard/tool-errors?period=&scope=&status=&tool=&agent=&q=&limit=&offset=`
 * -> `{ rows, total, agents, capped }`.
 *
 * The top-tools call detail: one page of tool calls (newest first) plus the
 * filtered total, the stable agent options and the Tier-P `capped` flag.
 * `?status=errors` (default) lists failed calls only, `?status=all` every call.
 * An invalid period/scope/status is the same 400 `{ error, field }` as
 * `/api/dashboard`; a data-layer failure is a generic 500 that never leaks
 * internals (`apiError` would echo them, so it is deliberately not used here).
 * Never cached.
 */
export const GET: RequestHandler = ({ url }) => {
	try {
		const resolved = resolveFilter(url);
		if (!resolved.ok) {
			resolved.response.headers.set('cache-control', NO_STORE);
			return resolved.response;
		}
		const status = parseStatus(url.searchParams.get('status'));
		if (status === null) {
			const invalid = invalidRequest(
				`Unknown status "${url.searchParams.get('status') ?? ''}".`,
				'status'
			);
			invalid.headers.set('cache-control', NO_STORE);
			return invalid;
		}
		const query: ToolErrorsQuery = {
			status,
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
