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
 */

const FORGE_BASE = 'https://forge-vtt.com/api';

/**
 * Call a Forge game-control endpoint.
 * @param {'start' | 'stop' | 'idle'} action
 * @param {{ game?: string, world?: string, force?: boolean }} [opts]
 * @returns {Promise<{ httpStatus: number, body: object }>}
 */
export async function controlGame(action, opts = {}) {
  const apiKey = process.env.FORGE_API_KEY;
  if (!apiKey) {
    throw new Error('FORGE_API_KEY not configured');
  }

  if (!['start', 'stop', 'idle'].includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }

  const headers = { 'Access-Key': apiKey };
  let body;

  // Only send a body if we have options to pass. Forge accepts either an
  // empty POST (defaults to main table) or JSON with game/world/force.
  const payload = {};
  if (opts.game) payload.game = String(opts.game);
  if (opts.world) payload.world = String(opts.world);
  if (opts.force) payload.force = true;

  if (Object.keys(payload).length > 0) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }

  const response = await fetch(`${FORGE_BASE}/game/${action}`, {
    method: 'POST',
    headers,
    body,
  });

  let parsed;
  const text = await response.text();
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  return { httpStatus: response.status, body: parsed };
}

/**
 * Validate that a slug is one of the configured games. This prevents an
 * authenticated user from passing arbitrary slugs to the Forge API.
 * @param {string} slug
 * @returns {boolean}
 */
export function isAllowedSlug(slug) {
  if (!slug) return false; // every action must target a specific game
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
