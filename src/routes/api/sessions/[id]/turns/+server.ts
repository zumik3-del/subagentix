import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listTurns } from '$lib/server/services/sessions';
import { apiError } from '$lib/server/http';

/**
 * `GET /api/sessions/[id]/turns` -> `TurnSummary[]` or 404.
 *
 * Lightweight sibling of `GET /api/sessions/[id]` (task #383): reads only the
 * requested session's turns, without the subtree CTE or the delegation edges.
 */
export const GET: RequestHandler = ({ params }) => {
	try {
		const turns = listTurns(params.id);
		if (turns === null) {
			return json({ error: `Unknown session "${params.id}".` }, { status: 404 });
		}
		return json(turns);
	} catch (cause) {
		return apiError(cause);
	}
};
