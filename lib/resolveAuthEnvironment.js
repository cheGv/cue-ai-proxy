// lib/resolveAuthEnvironment.js
//
// Phase C — issuer-aware auth. The proxy fronts TWO Supabase projects
// (production + sandbox) from one deployment. A Supabase access token's
// `iss` claim names the GoTrue that minted it; this helper decodes that
// claim (WITHOUT verifying the signature) and returns the matching
// project's URL + anon/service-role keys.
//
// Why no signature check here: we are not trusting the token yet. The
// (unverified) issuer is used only to choose WHICH project's GoTrue to
// ask. requireAuth then calls auth.getUser() against the resolved project,
// which performs the real cryptographic verification. A forged iss can at
// most route a token to the wrong real project, where getUser() rejects
// it — it can never grant access.
//
// Known project URLs are hardcoded (project refs are stable identifiers).
// The secret keys are read from env so they never live in source.
//
// Required env vars:
//   prod    — SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   sandbox — SUPABASE_URL_SANDBOX, SUPABASE_ANON_KEY_SANDBOX,
//             SUPABASE_SERVICE_ROLE_KEY_SANDBOX

class AuthEnvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthEnvError';
  }
}

const PROD_URL    = 'https://cgnjbjbargkxtcnafxaa.supabase.co';
const SANDBOX_URL = 'https://uuqhusmgoiaxdvtgbmwh.supabase.co';

// Decode a JWT's payload segment without verifying its signature.
// Throws AuthEnvError on any structural problem.
function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new AuthEnvError('Token missing');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthEnvError('Malformed token: expected three segments');
  }
  let jsonStr;
  try {
    jsonStr = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch (_) {
    throw new AuthEnvError('Malformed token: payload is not valid base64url');
  }
  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch (_) {
    throw new AuthEnvError('Malformed token: payload is not valid JSON');
  }
  if (!payload || typeof payload !== 'object') {
    throw new AuthEnvError('Malformed token: payload is not an object');
  }
  return payload;
}

// Resolve which Cue project a token belongs to, by its iss claim.
// Returns { env, url, anonKey, serviceRoleKey }. Throws AuthEnvError when
// the token is malformed or its issuer is not a known Cue project.
function resolveAuthEnvironment(token) {
  const payload = decodeJwtPayload(token);
  const iss = payload.iss;
  if (typeof iss !== 'string' || iss.length === 0) {
    throw new AuthEnvError('Token has no issuer (iss) claim');
  }
  // Supabase access tokens carry iss = "https://<ref>.supabase.co/auth/v1".
  // Match on the project base URL prefix so the /auth/v1 suffix is ignored.
  if (iss.startsWith(PROD_URL)) {
    return {
      env: 'prod',
      url: PROD_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
  }
  if (iss.startsWith(SANDBOX_URL)) {
    return {
      env: 'sandbox',
      url: SANDBOX_URL,
      anonKey: process.env.SUPABASE_ANON_KEY_SANDBOX,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY_SANDBOX,
    };
  }
  throw new AuthEnvError(`Token issuer not a known Cue project: ${iss}`);
}

module.exports = {
  resolveAuthEnvironment,
  decodeJwtPayload,
  AuthEnvError,
  PROD_URL,
  SANDBOX_URL,
};
