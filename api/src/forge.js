/**
 * The Forge API client.
 *
 * All requests use the FORGE_API_KEY environment variable, which in Azure is
 * populated from a Key Vault reference. The key never reaches the browser.
 *
 * Endpoints: https://forums.forge-vtt.com/t/5982
 *   POST /api/game/start  - Start the server (boots into Foundry setup page)
 *   POST /api/game/stop   - Stop immediately; users get kicked
 *   POST /api/game/idle   - Stop if idle; auto-start on access; can specify world
 *
 * SWA-linked-backend timeout: The Static Web App's edge enforces a ~30s
 * timeout on requests proxied to linked Functions. Forge `start` calls can
 * exceed that (they wait for the Foundry instance to fully boot). We race
 * the fetch against a soft timeout: if Forge responds within the window,
 * we return the real response; if not, we return a "command accepted"
 * placeholder and let the upstream call finish in the background.
 */

const FORGE_BASE = 'https://forge-vtt.com/api';

// Leave 5 seconds of slack under the 30s SWA edge timeout
const FORGE_RESPONSE_WAIT_MS = 25_000;

/**
 * Call a Forge game-control endpoint.
 * @param {'start' | 'stop' | 'idle'} action
 * @param {{ game?: string, world?: string, force?: boolean }} [opts]
 * @returns {Promise<{ httpStatus: number, body: object }>}
 */
export async function controlGame(action, opts = {}) {
  const rawKey = process.env.FORGE_API_KEY;
  if (!rawKey) {
    throw new Error('FORGE_API_KEY not configured');
  }

  // Defensive: trim any whitespace/CRLF the env-var pipeline may introduce.
  const apiKey = rawKey.trim();

  if (!['start', 'stop', 'idle'].includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }

  const headers = { 'Access-Key': apiKey };
  let body;

  const payload = {};
  if (opts.game) payload.game = String(opts.game);
  if (opts.world) payload.world = String(opts.world);
  if (opts.force) payload.force = true;

  if (Object.keys(payload).length > 0) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }

  const fetchPromise = fetch(`${FORGE_BASE}/game/${action}`, {
    method: 'POST',
    headers,
    body,
  }).then(async (response) => {
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { httpStatus: response.status, body: parsed };
  });

  // Race the fetch against a soft timeout. If Forge is slow (typical for
  // `start`), we hand back a 202 Accepted so the SWA edge doesn't time out.
  // The fetch promise itself is intentionally NOT cancelled — it continues
  // running in the Function instance and the Forge call completes normally.
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        httpStatus: 202,
        body: {
          success: null,
          pending: true,
          message: 'Command accepted; the Forge is still working on it. This usually means the server is booting and may take another minute. Refresh the game URL after ~30s to check.',
        },
      });
    }, FORGE_RESPONSE_WAIT_MS);
  });

  // Swallow background errors so they don't crash the Function process
  // after we've already returned. They're not user-actionable in this path.
  fetchPromise.catch(() => {});

  return Promise.race([fetchPromise, timeoutPromise]);
}

/**
 * Validate that a slug is one of the configured games. This prevents an
 * authenticated user from passing arbitrary slugs to the Forge API.
 * @param {string} slug
 * @returns {boolean}
 */
export function isAllowedSlug(slug) {
  if (!slug) return false;
  let configured;
  try {
    configured = JSON.parse(process.env.FORGE_GAME_SLUGS || '[]');
  } catch {
    return false;
  }
  return Array.isArray(configured) && configured.includes(slug);
}

/**
 * Get the configured list of game slugs.
 * NOTE: The Forge does not expose a documented "list my games" endpoint.
 * If one becomes available, swap this function to call it directly.
 * @returns {string[]}
 */
export function getConfiguredSlugs() {
  try {
    const parsed = JSON.parse(process.env.FORGE_GAME_SLUGS || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
