import { app } from '@azure/functions';
import { getAuthorizedPrincipal, jsonError, jsonOk } from '../auth.js';
import { controlGame, isAllowedSlug } from '../forge.js';

/**
 * POST /api/control/{action}
 *
 * action: "start" | "stop" | "idle"
 * body (all optional):
 *   game:  string  - URL slug; must be in FORGE_GAME_SLUGS
 *   world: string  - (idle only) override last-used world
 *   force: boolean - (idle only) idle even if users connected
 */
app.http('control', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'control/{action}',
  handler: async (request, context) => {
    const auth = getAuthorizedPrincipal(request);
    if (!auth.ok) {
      context.log(`Auth rejected: ${auth.error}`);
      return jsonError(auth.status, auth.error);
    }

    const action = request.params.action;
    if (!['start', 'stop', 'idle'].includes(action)) {
      return jsonError(400, `Invalid action: ${action}`);
    }

    let payload = {};
    try {
      const text = await request.text();
      if (text) payload = JSON.parse(text);
    } catch {
      return jsonError(400, 'Invalid JSON body');
    }

    if (!payload.game) {
      return jsonError(400, 'Missing required field: game');
    }
    if (!isAllowedSlug(payload.game)) {
      // Don't echo the bad slug back — keeps logs/responses clean
      return jsonError(400, 'Requested game is not in the configured allowlist');
    }

    // Only "idle" accepts world/force per Forge docs; silently drop them otherwise
    const opts = { game: payload.game };
    if (action === 'idle') {
      if (payload.world) opts.world = payload.world;
      if (payload.force) opts.force = true;
    }

    try {
      const { httpStatus, body } = await controlGame(action, opts);
      context.log(
        `User ${auth.principal.userDetails} performed ${action} on ${opts.game}; Forge replied ${httpStatus}`
      );
      return {
        status: httpStatus,
        jsonBody: body,
      };
    } catch (err) {
      context.error(`Forge call failed: ${err.message}`);
      // DIAGNOSTIC: include error details in response. Remove after debugging.
      return {
        status: 502,
        jsonBody: {
          error: 'Upstream Forge request failed',
          debug: {
            message: err.message,
            name: err.name,
            cause: err.cause?.message || err.cause || null,
            keyConfigured: !!process.env.FORGE_API_KEY,
            keyLength: process.env.FORGE_API_KEY?.length || 0,
          },
        },
      };
    }
  },
});
