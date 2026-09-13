import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildNodeDetail } from '$lib/server/services/nodes';
import { apiError } from '$lib/server/http';

/**
 * `GET /api/sessions/[id]/nodes/[nodeId]?turn=<triggerId>` -> `NodeDetail`.
 *
 * `?turn=` is optional; without it the node is located in a turn of the root
 * session that contains it. Read-only. `404` for an unknown root/turn/node,
 * `503` when the DB is unavailable (via `apiError`, like the turns route).
 */
export const GET: RequestHandler = ({ params, url }) => {
	try {
		const turnId = url.searchParams.get('turn') ?? undefined;
		const detail = buildNodeDetail(params.id, params.nodeId, turnId);
		if (!detail) {
			return json(
				{
					error: `Unknown root session "${params.id}", turn or node "${params.nodeId}".`
				},
				{ status: 404 }
			);
		}
		return json(detail);
	} catch (cause) {
		return apiError(cause);
	}
};
