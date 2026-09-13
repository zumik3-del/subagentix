import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSessionDetail } from '$lib/server/services/sessions';
import { apiError } from '$lib/server/http';

/** `GET /api/sessions/[id]` -> `SessionDetail` or 404. */
export const GET: RequestHandler = ({ params }) => {
	try {
		const detail = getSessionDetail(params.id);
		if (!detail) {
			return json({ error: `Unknown session "${params.id}".` }, { status: 404 });
		}
		return json(detail);
	} catch (cause) {
		return apiError(cause);
	}
};
