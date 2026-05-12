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
 * It does NOT include the full claims array that /.auth/me returns. So we
 * cannot inspect the tenant claim (`tid`) from inside the Function.
 *
 * Tenant restriction is instead enforced at the AAD layer via the app
 * registration's signInAudience=AzureADMyOrg — Microsoft only lets users from
 * our tenant complete the sign-in flow in the first place. By the time the
 * principal reaches us, AAD has already gatekept on tenant.
 *
 * We additionally enforce, in this file:
 *   - identityProvider === "aad" (Entra ID, not GitHub/Twitter/etc.)
 *   - userDetails (email) is in the ALLOWED_EMAILS allowlist
 *
 * Direct calls to the Function URL bypass SWA and will have no principal header,
 * so they are rejected. The Function is further locked down by Bicep to only
 * accept traffic from the SWA's linked backend.
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

  const allowlistRaw = process.env.ALLOWED_EMAILS || '[]';
  let allowlist;
  try {
    allowlist = JSON.parse(allowlistRaw).map((e) => String(e).toLowerCase().trim());
  } catch {
    return { ok: false, status: 500, error: 'Server misconfiguration: ALLOWED_EMAILS not valid JSON' };
  }

  if (!allowlist.includes(email)) {
    return { ok: false, status: 403, error: 'User not on allowlist' };
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
