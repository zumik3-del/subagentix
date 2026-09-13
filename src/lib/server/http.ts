import { json } from '@sveltejs/kit';

/**
 * Uniform JSON error response for the read-only API routes. The data layer's
 * own errors already explain a missing/unreadable DB (ADR §4.5, R2); this only
 * shapes them, it never retries with a mutating open.
 */
export function apiError(cause: unknown, status = 503): Response {
	const message = cause instanceof Error ? cause.message : String(cause);
	return json({ error: message }, { status });
}

/**
 * 400 validation response. `field` names the offending request field when the
 * failure can be attributed to one (ADR §6.2 `{ error, field }`).
 */
export function invalidRequest(message: string, field?: string): Response {
	return json(field === undefined ? { error: message } : { error: message, field }, { status: 400 });
}
