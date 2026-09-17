import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadWidgetData, resolveDashboardRequest } from '../widgets';

/** Widget data is per-request state; the server memo owns performance. */
const NO_STORE = 'no-store';

/**
 * `GET /api/dashboard/[widget]?period=<all|7d|30d|90d>&scope=<all|<directory>>[&refresh=1]`
 * -> `{ widgetId, generatedAt, data }`.
 *
 * Unknown widget id -> 404; an invalid period/scope -> 400 `{ error, field }`;
 * a data-layer failure -> a generic 500 that never leaks internals (`apiError`
 * would echo them, so it is deliberately not used here).
 */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const request = resolveDashboardRequest(params.widget, url);
		const response = request.ok
			? json(
					await loadWidgetData(
						request.widgetId,
						request.filter,
						request.settings,
						url.searchParams.get('refresh') === '1'
					)
				)
			: request.response;
		response.headers.set('cache-control', NO_STORE);
		return response;
	} catch (cause) {
		console.error('[api/dashboard] widget load failed:', cause);
		return json(
			{ error: 'Failed to load dashboard data.' },
			{ status: 500, headers: { 'cache-control': NO_STORE } }
		);
	}
};
