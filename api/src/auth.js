/**
 * Auth helper for SWA-linked Azure Functions.
 *
 * Static Web Apps injects an `x-ms-client-principal` header containing a
 * base64-encoded JSON object describing the authenticated user, but ONLY when:
 *   1. The request came through the SWA frontend (not directly to the Function)
 *   2. The user has signed in via a configured identity provider
 *
 * We additionally enforce:
 *   - identityProvider === "aad" (Entra ID, not GitHub/Twitter/etc.)
 *   - The token's tenant claim (`tid`) matches REQUIRED_TENANT_ID
 *   - userDetails (email) is in the ALLOWED_EMAILS allowlist
 *
 * The tenant check matters because SWA's pre-configured AAD identity provider
 * accepts users from ANY Entra tenant by default. Without this, a malicious
 * actor could sign in with their own tenant and only the email allowlist
 * would protect us. Belt and suspenders.
 *
 * Direct calls to the Function URL bypass SWA and will have no principal header,
 * so they are rejected. The Function is further locked down by Bicep to only
 * accept traffic from the SWA's linked backend.
 */

const TID_CLAIM_TYPES = [
  'http://schemas.microsoft.com/identity/claims/tenantid',
  'tid',
];

const EMAIL_CLAIM_TYPES = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'emails',
  'preferred_username',
  'upn',
];

/**
 * Pull the first matching claim value from the SWA principal's claims array.
 */
function findClaim(principal, types) {
  if (!Array.isArray(principal.claims)) return null;
  for (const t of types) {
    const c = principal.claims.find((x) => x?.typ === t || x?.type === t);
    if (c && c.val) return c.val;
    if (c && c.value) return c.value;
  }
  return null;
}

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

  // Tenant enforcement. With the pre-configured AAD provider, SWA allows any
  // tenant unless we check ourselves.
  const requiredTenant = (process.env.REQUIRED_TENANT_ID || '').trim();
  if (!requiredTenant) {
    return {
      ok: false,
      status: 500,
      error: 'Server misconfiguration: REQUIRED_TENANT_ID not set',
    };
  }
  const tokenTenant = findClaim(principal, TID_CLAIM_TYPES);
  if (!tokenTenant || tokenTenant.toLowerCase() !== requiredTenant.toLowerCase()) {
    // TEMPORARY DIAGNOSTIC — remove after debugging
    console.log(`TENANT MISMATCH DEBUG: tokenTenant=${JSON.stringify(tokenTenant)} (len=${tokenTenant?.length}) requiredTenant=${JSON.stringify(requiredTenant)} (len=${requiredTenant.length})`);
    return { ok: false, status: 403, error: 'User is not from an allowed tenant' };
  }

  // Email allowlist. userDetails is populated from userDetailsClaim in the SWA
  // config (which we point at the email claim), with claims as a fallback.
  const email = (
    principal.userDetails ||
    findClaim(principal, EMAIL_CLAIM_TYPES) ||
    ''
  )
    .toLowerCase()
    .trim();
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
