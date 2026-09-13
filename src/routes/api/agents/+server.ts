import { json } from '@sveltejs/kit';
import { isAbsolute } from 'node:path';
import type { RequestHandler } from './$types';
import { invalidRequest } from '$lib/server/http';
import { listAgents } from '$lib/server/agents';
import { resolveAgentsPath } from '$lib/server/settings';
import { invalidateAgentColors } from '$lib/server/agent-colors';

/**
 * `GET /api/agents?path=<abs>[&refresh=1]` -> the subagents parsed from one
 * directory. When `path` is omitted the effective `agentsPath` setting is
 * used. `refresh=1` also drops the color cache so the Gantt re-reads the disk.
 */
export const GET: RequestHandler = ({ url }) => {
	const requested = url.searchParams.get('path');
	const target = requested ?? resolveAgentsPath();
	if (target === null || target.trim() === '') {
		return invalidRequest('A subagents directory path is required.', 'path');
	}
	if (!isAbsolute(target)) {
		return invalidRequest('path must be an absolute path.', 'path');
	}
	if (url.searchParams.get('refresh') === '1') invalidateAgentColors();
	return json(listAgents(target));
};
