// Tests for the issuer-aware auth environment resolver.
// Run with:  npm test   (node --test)
//
// These are pure unit tests — no live Supabase. They prove the iss-decode
// + project routing in isolation. End-to-end verification (a real sandbox
// token actually clearing getUser() against the sandbox project) is a
// manual step, per PART D2.

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveAuthEnvironment,
  AuthEnvError,
  PROD_URL,
  SANDBOX_URL,
} = require('../lib/resolveAuthEnvironment');

// Build an unsigned JWT (header.payload.signature). The signature is
// irrelevant — the resolver decodes the payload but never verifies it.
function makeToken(payload) {
  const seg = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.not-a-real-signature`;
}

test('valid prod token resolves to the prod environment', () => {
  const token = makeToken({ iss: `${PROD_URL}/auth/v1`, sub: 'user-1', role: 'authenticated' });
  const env = resolveAuthEnvironment(token);
  assert.strictEqual(env.env, 'prod');
  assert.strictEqual(env.url, PROD_URL);
});

test('valid sandbox token resolves to the sandbox environment', () => {
  const token = makeToken({ iss: `${SANDBOX_URL}/auth/v1`, sub: 'user-2', role: 'authenticated' });
  const env = resolveAuthEnvironment(token);
  assert.strictEqual(env.env, 'sandbox');
  assert.strictEqual(env.url, SANDBOX_URL);
});

test('token with an unknown issuer is rejected', () => {
  const token = makeToken({ iss: 'https://evil-project.supabase.co/auth/v1', sub: 'user-3' });
  assert.throws(() => resolveAuthEnvironment(token), AuthEnvError);
});

test('token with no iss claim is rejected', () => {
  const token = makeToken({ sub: 'user-4', role: 'authenticated' });
  assert.throws(() => resolveAuthEnvironment(token), AuthEnvError);
});

test('malformed token (not three segments) is rejected', () => {
  assert.throws(() => resolveAuthEnvironment('not-a-jwt'), AuthEnvError);
});

test('malformed token (payload is not valid JSON) is rejected', () => {
  const badPayload = Buffer.from('this is not json').toString('base64url');
  assert.throws(() => resolveAuthEnvironment(`aaa.${badPayload}.sig`), AuthEnvError);
});

test('empty or missing token is rejected', () => {
  assert.throws(() => resolveAuthEnvironment(''), AuthEnvError);
  assert.throws(() => resolveAuthEnvironment(undefined), AuthEnvError);
});
