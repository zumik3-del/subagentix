import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildTurnModel } from '$lib/server/services/turn';
import { apiError } from '$lib/server/http';

/** `GET /api/sessions/[id]/turns/[turnId]` -> `GanttModel` or 404. */
export const GET: RequestHandler = ({ params }) => {
	try {
		const model = buildTurnModel(params.id, params.turnId);
		if (!model) {
			return json(
				{ error: `Unknown root session "${params.id}" or trigger message "${params.turnId}".` },
				{ status: 404 }
			);
		}
		return json(model);
	} catch (cause) {
		return apiError(cause);
	}
};
