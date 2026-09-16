import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiError, invalidRequest } from '$lib/server/http';
import { probeOpencodeDb } from '$lib/server/db-probe';
import {
	getStoredSettings,
	resolveAgentsPath,
	resolveDashboardWidgets,
	resolveDbPath,
	resolveZiptaskBaseUrl,
	resolveZiptaskEnabled,
	SettingsValidationError,
	updateStoredSettings
} from '$lib/server/settings';
import type { WidgetPlacement } from '$lib/widgets/registry';

type Source = 'file' | 'env' | 'default' | 'none';

interface SettingsPayload {
	dbPath: string;
	ziptaskBaseUrl: string | null;
	ziptaskEnabled: boolean;
	agentsPath: string | null;
	dashboardWidgets: WidgetPlacement[];
	stored: {
		dbPath: string | null;
		ziptaskBaseUrl: string | null;
		ziptaskEnabled: boolean | null;
		agentsPath: string | null;
		dashboardWidgets: WidgetPlacement[] | null;
	};
	source: {
		dbPath: Source;
		ziptaskBaseUrl: Source;
		ziptaskEnabled: Source;
		agentsPath: Source;
		dashboardWidgets: Source;
	};
}

/** Effective + stored values and the layer each effective value came from. */
function settingsPayload(): SettingsPayload {
	const stored = getStoredSettings();
	return {
		dbPath: resolveDbPath(),
		ziptaskBaseUrl: resolveZiptaskBaseUrl(),
		ziptaskEnabled: resolveZiptaskEnabled(),
		agentsPath: resolveAgentsPath(),
		dashboardWidgets: resolveDashboardWidgets(),
		stored: {
			dbPath: stored.dbPath ?? null,
			ziptaskBaseUrl: stored.ziptaskBaseUrl ?? null,
			ziptaskEnabled: typeof stored.ziptaskEnabled === 'boolean' ? stored.ziptaskEnabled : null,
			agentsPath: stored.agentsPath ?? null,
			dashboardWidgets: stored.dashboardWidgets ?? null
		},
		source: {
			dbPath: stored.dbPath ? 'file' : process.env.OPENCODE_DB ? 'env' : 'default',
			ziptaskBaseUrl: stored.ziptaskBaseUrl ? 'file' : process.env.ZIPTASK_BASE_URL ? 'env' : 'none',
			ziptaskEnabled:
				typeof stored.ziptaskEnabled === 'boolean'
					? 'file'
					: process.env.ZIPTASK_ENABLED
						? 'env'
						: 'default',
			agentsPath: stored.agentsPath ? 'file' : process.env.OPENCODE_AGENTS_DIR ? 'env' : 'none',
			// Explicit empty selection is still a stored ("file") value; only a
			// missing/null override falls back to the first-visit defaults.
			dashboardWidgets: stored.dashboardWidgets != null ? 'file' : 'default'
		}
	};
}

export const GET: RequestHandler = () => {
	try {
		return json(settingsPayload());
	} catch (error) {
		return apiError(error, 500);
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return invalidRequest('Request body must be a JSON object.');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return invalidRequest('Request body must be a JSON object.');
	}

	const record = body as Record<string, unknown>;
	const patch: {
		dbPath?: string | null;
		ziptaskBaseUrl?: string | null;
		ziptaskEnabled?: boolean | null;
		agentsPath?: string | null;
		dashboardWidgets?: WidgetPlacement[] | null;
	} = {};
	if (Object.prototype.hasOwnProperty.call(record, 'dbPath')) {
		patch.dbPath = record.dbPath as string | null;
	}
	if (Object.prototype.hasOwnProperty.call(record, 'ziptaskBaseUrl')) {
		patch.ziptaskBaseUrl = record.ziptaskBaseUrl as string | null;
	}
	if (Object.prototype.hasOwnProperty.call(record, 'ziptaskEnabled')) {
		patch.ziptaskEnabled = record.ziptaskEnabled as boolean | null;
	}
	if (Object.prototype.hasOwnProperty.call(record, 'agentsPath')) {
		patch.agentsPath = record.agentsPath as string | null;
	}
	if (Object.prototype.hasOwnProperty.call(record, 'dashboardWidgets')) {
		// Legacy `string[]` payloads are still accepted and normalised downstream.
		patch.dashboardWidgets = record.dashboardWidgets as WidgetPlacement[] | null;
	}

	try {
		updateStoredSettings(patch);
	} catch (error) {
		if (error instanceof SettingsValidationError) {
			return invalidRequest(error.message, error.field);
		}
		return apiError(error, 500);
	}

	const payload = settingsPayload();
	let warning: string | undefined;
	if (typeof patch.dbPath === 'string' && probeOpencodeDb(payload.dbPath) === null) {
		warning = `Settings saved, but no opencode database was found at "${payload.dbPath}".`;
	}
	return json(warning === undefined ? payload : { ...payload, warning });
};
