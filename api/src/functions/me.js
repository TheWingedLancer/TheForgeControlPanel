import { app } from '@azure/functions';
import { getAuthorizedPrincipal, jsonError, jsonOk } from '../auth.js';

/**
 * GET /api/me - return the authenticated user's email. Useful for the frontend
 * to display "signed in as ..." without re-deriving from /.auth/me.
 */
app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: async (request, context) => {
    const auth = getAuthorizedPrincipal(request);
    if (!auth.ok) {
      // Surface debug info in the body if present (diagnostic only)
      const body = { error: auth.error };
      if (auth.debug) body.debug = auth.debug;
      return { status: auth.status, jsonBody: body };
    }
    return jsonOk({
      email: auth.principal.userDetails,
      identityProvider: auth.principal.identityProvider,
    });
  },
});
