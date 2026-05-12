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
      return jsonError(auth.status, auth.error);
    }
    return jsonOk({
      email: auth.principal.userDetails,
      identityProvider: auth.principal.identityProvider,
    });
  },
});
