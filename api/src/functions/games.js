import { app } from '@azure/functions';
import { getAuthorizedPrincipal, jsonError, jsonOk } from '../auth.js';
import { getConfiguredSlugs } from '../forge.js';

/**
 * Turn a Forge subdomain slug into a friendlier label.
 * "age-of-crusades" → "Age Of Crusades"
 * "jeramiebrown-warhammer" → "Jeramiebrown Warhammer"
 *
 * Not perfect for every slug (won't recognize that "jeramiebrown" is a name),
 * but better than showing the raw slug. Users can also override via a manual
 * config later if they want custom labels.
 */
function slugToLabel(slug) {
  return slug
    .split('-')
    .map((word) => (word.length ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

app.http('games', {
  methods: ['GET'],
  authLevel: 'anonymous', // SWA-injected principal is our auth, not Functions keys
  route: 'games',
  handler: async (request, context) => {
    const auth = getAuthorizedPrincipal(request);
    if (!auth.ok) {
      context.log(`Auth rejected: ${auth.error}`);
      return jsonError(auth.status, auth.error);
    }

    const slugs = getConfiguredSlugs();
    return jsonOk({
      games: slugs.map((slug) => ({ slug, label: slugToLabel(slug) })),
    });
  },
});
