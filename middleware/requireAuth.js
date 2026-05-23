// Phase C — issuer-aware JWT verification middleware.
//
// The proxy fronts TWO Supabase projects (production + sandbox) from a
// single deployment. The incoming token's `iss` claim says which project
// minted it; resolveAuthEnvironment() (lib/resolveAuthEnvironment.js) maps
// that to the project's URL + anon/service-role keys WITHOUT trusting the
// token yet. auth.getUser() then verifies the token against the resolved
// project's GoTrue — the real cryptographic check.
//
// Behavior:
//   • Reads Authorization: Bearer <token>.
//   • Resolves the token's project by its iss claim. Unknown issuer or a
//     malformed token → 401 (never reaches GoTrue).
//   • Verifies via auth.getUser() against the RESOLVED project URL + anon.
//   • On success: attaches `req.user` (the Supabase auth user object —
//     `req.user.id` is the clinician_id used downstream) and `req.authEnv`
//     = { env, url, serviceRoleKey } so downstream service-role DB writes
//     target the SAME project without re-decoding the token.
//   • On failure: responds 401 with a JSON error and short-circuits.
//
// Prod behavior is unchanged: a prod token resolves to the exact same URL
// + keys this middleware used before (process.env.SUPABASE_URL etc.). The
// sandbox branch only activates for sandbox-issued tokens, and only when
// the SUPABASE_*_SANDBOX env vars are present.
//
// Required env vars:
//   prod    — SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   sandbox — SUPABASE_URL_SANDBOX, SUPABASE_ANON_KEY_SANDBOX,
//             SUPABASE_SERVICE_ROLE_KEY_SANDBOX

const { createClient } = require('@supabase/supabase-js');
const { resolveAuthEnvironment } = require('../lib/resolveAuthEnvironment');

module.exports = async function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = auth.split(' ')[1];

  let resolved;
  try {
    resolved = resolveAuthEnvironment(token);
  } catch (e) {
    // Unknown issuer or malformed token — reject before any network call.
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const userClient = createClient(
    resolved.url,
    resolved.anonKey,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  try {
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    // Resolved environment travels with the request so downstream
    // service-role clients hit the same project (no second iss decode).
    req.authEnv = {
      env: resolved.env,
      url: resolved.url,
      serviceRoleKey: resolved.serviceRoleKey,
    };
    return next();
  } catch (e) {
    console.error('[requireAuth] verification exception:', e.message);
    return res.status(401).json({ error: 'Auth verification failed' });
  }
};
