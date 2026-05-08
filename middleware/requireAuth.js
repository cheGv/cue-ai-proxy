// Phase 4.0.7.40-proxy-rebuild — JWT verification middleware.
//
// Mirrors the inline auth pattern that ships in
// routes/generateGoals.js (lines 24-38). Extracted here so
// /generate-report (and future endpoints that need clinician
// identity for RLS-aware DB writes or audit logging) can mount
// it as a single line.
//
// Behavior:
//   • Reads Authorization: Bearer <token> from the request.
//   • Validates the token via @supabase/supabase-js
//     (auth.getUser hits the live JWKS endpoint, so key
//     rotation, revocation, and expiry are honored without
//     local caching).
//   • On success: attaches `req.user` (the Supabase auth user
//     object — `req.user.id` is the clinician_id used downstream).
//   • On failure: responds 401 with a JSON error and short-circuits.
//
// Required env vars: SUPABASE_URL, SUPABASE_ANON_KEY. Both are
// already configured on Render for /api/generate-goals.
//
// generateGoals.js intentionally keeps its inline copy for
// 4.0.7.40 scope discipline; a follow-up phase can DRY it.

const { createClient } = require('@supabase/supabase-js');

module.exports = async function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = auth.split(' ')[1];

  const userClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  try {
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    return next();
  } catch (e) {
    console.error('[requireAuth] verification exception:', e.message);
    return res.status(401).json({ error: 'Auth verification failed' });
  }
};
