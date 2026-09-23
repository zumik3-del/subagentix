import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiError, invalidRequest } from '$lib/server/http';
import { readFileContent } from '$lib/server/services/files';

/** Contents are live disk state; never let the browser or a proxy cache them. */
function noStore(response: Response): Response {
	response.headers.set('Cache-Control', 'no-store');
	return response;
}

/**
 * `GET /api/files/content?block=&path=` -> one allowlisted file's text (§5.2).
 * `block` is `global` or `project:<id>`; `path` is the POSIX relative path
 * exactly as returned by `/api/files`. Statuses: 200 `FileContent`; 400
 * `{ error, field }` (missing/blank `block`/`path`, malformed block id,
 * non-allowlisted/traversal path); 403 (unreadable); 404 (unknown block/project
 * or missing file); 413 `{ error, size, limit }` (over 512 KiB); 503 when the
 * DB is unreachable while resolving a `project:` block.
 */
export const GET: RequestHandler = ({ url }) => {
	try {
		const block = url.searchParams.get('block') ?? '';
		const path = url.searchParams.get('path') ?? '';
		const result = readFileContent(block, path);
		if (result.ok) return noStore(json(result.content));
		if (result.status === 400) return noStore(invalidRequest(result.error, result.field));
		if (result.status === 503) return noStore(apiError(result.error, 503));
		if (result.status === 413) {
			return noStore(
				json({ error: result.error, size: result.size, limit: result.limit }, { status: 413 })
			);
		}
		return noStore(json({ error: result.error }, { status: result.status }));
	} catch (cause) {
		return noStore(apiError(cause, 500));
	}
};
