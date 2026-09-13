/**
 * Server bootstrap.
 *
 * Starts the opencode permission-event collector once per process so permission
 * asks/replies are persisted while the app runs (opencode itself keeps no
 * history).
 *
 * Skipped under `bun test` (a live SSE fetch would keep spawned test servers
 * from exiting) and when `DISABLE_PERMISSION_COLLECTOR=1` is set.
 */
import { startPermissionCollector } from '$lib/server/permission-collector';

if (process.env.NODE_ENV !== 'test' && process.env.DISABLE_PERMISSION_COLLECTOR !== '1') {
	startPermissionCollector();
}
