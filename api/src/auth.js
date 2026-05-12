/**
 * Auth helper for SWA-linked Azure Functions.
 *
 * Static Web Apps injects an `x-ms-client-principal` header containing a
 * base64-encoded JSON object describing the authenticated user, but ONLY when:
 *   1. The request came through the SWA frontend (not directly to the Function)
 *   2. The user has signed in via a configured identity provider
 *
 * The header passed to LINKED-BACKEND Functions uses a slim format:
 *   { identityProvider, userId, userDetails, userRoles }
 * It does NOT include the full claims array that /.auth/me returns.
 *
 * Access control is enforced at the AAD layer via the Enterprise Application
 * configuration (appRoleAssignmentRequired=true). Only users explicitly
 * assigned to the app in Entra ID → Enterprise applications → Users and
 * groups can complete the sign-in flow. By the time the principal reaches
 * this code, Entra has already gatekept who is allowed in.
 *
 * We additionally enforce here:
 *   - identityProvider === "aad" (so non-AAD callers can't sneak in)
 *   - userDetails is non-empty (so we can attribute actions to a real user)
 *
 * Direct calls to the Function URL bypass SWA and will have no principal
 * header, so they are rejected.
 */

/**
 * Parse and validate the client principal from request headers.
 * @param {import('@azure/functions').HttpRequest} request
 * @returns {{ ok: true, principal: object } | { ok: false, status: number, error: string }}
 */
export function getAuthorizedPrincipal(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) {
    return { ok: false, status: 401, error: 'Not authenticated' };
  }

  let principal;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    principal = JSON.parse(decoded);
  } catch {
    return { ok: false, status: 401, error: 'Malformed principal header' };
  }

  if (principal.identityProvider !== 'aad') {
    return { ok: false, status: 403, error: 'Unsupported identity provider' };
  }

  const email = (principal.userDetails || '').toLowerCase().trim();
  if (!email) {
    return { ok: false, status: 403, error: 'No user identifier on principal' };
  }

  return { ok: true, principal: { ...principal, userDetails: email } };
}

/**
 * Build a standardized JSON error response.
 */
export function jsonError(status, message) {
  return {
    status,
    jsonBody: { error: message },
  };
}

/**
 * Build a standardized JSON success response.
 */
export function jsonOk(body) {
  return {
    status: 200,
    jsonBody: body,
  };
}
