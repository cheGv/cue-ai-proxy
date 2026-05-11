# NEXT_STEPS

Open items that the /cue-reasoning endpoint depends on but does NOT own.

## 1. Add `slp_profiles.response_style` column

The /cue-reasoning route reads `slp_profiles.response_style` to drive the
STYLE-PREFERENCE OVERRIDE block in the Cue Reasoning system prompt. The
column does not exist yet on the `cue` Supabase project (`cgnjbjbargkxtcnafxaa`).

While the column is missing, the lookup returns a Postgres error and the
route falls back to `'balanced'` — no user-visible breakage, but every
/cue-reasoning request logs a warning. Add the column to clear the warning
and let SLPs choose `narrative` or `bullets`.

Migration (apply via the project's normal migration workflow — this repo
does not own DB migrations):

```sql
alter table public.slp_profiles
  add column response_style text
    not null
    default 'balanced'
    check (response_style in ('narrative', 'bullets', 'balanced'));
```

Notes:
- Default `'balanced'` matches the route's fallback, so existing rows
  start in the same state the route assumes.
- The check constraint mirrors the three values the prompt branches on.
  If a new style is added later, update both the constraint and the
  STYLE-PREFERENCE OVERRIDE block in `prompts/cueReasoning.js` in lockstep.
- RLS stays disabled — do not add policies as part of this migration.

## 2. Flutter client request contract

The /cue-reasoning route is gated by `requireAuth` and expects:

```
POST /cue-reasoning
Authorization: Bearer <supabase-jwt>
Content-Type: application/json

{
  "client_id":            "<clients.id uuid>",
  "message":              "<latest user turn>",
  "conversation_history": [{ "role": "user|assistant", "content": "..." }]
}
```

Identity (`slp_id` / `clinician_id`) is derived from the JWT on the
`Authorization` header — Flutter must NOT send `slp_id` in the body.
The server enforces ownership: if the authenticated SLP does not own
`client_id`, the route returns 403.

If the Flutter client is still sending the old `/cue-study` shape
(`{ messages, chart_context }`) it needs to be updated to the new shape
above when migrating off `/cue-study`. The legacy `/cue-study` endpoint
is left in place and untouched.

## 2.1 — /cue-reasoning request contract (canonical)

```
POST https://cue-ai-proxy.onrender.com/cue-reasoning
Authorization: Bearer <supabase access token>
Content-Type: application/json
```

Body:

```json
{
  "client_id":            "<clients.id uuid>",
  "message":              "<latest user turn>",
  "conversation_history": [{ "role": "user|assistant", "content": "..." }]
}
```

Status codes returned by handler:

- `400` — missing `message` or `client_id` in body
- `401` — missing/invalid JWT (from `requireAuth` middleware)
- `403` — `Client not found or access denied` (ownership check failed —
  SLP does not own this `client_id`)
- `500` — `Client lookup failed` (DB error) **or** `Cue Reasoning request
  failed` (internal error)
- Upstream Anthropic status passed through on Anthropic API errors

Notes for Flutter integration:

- `slp_id` is NEVER sent in body; derived server-side from `req.user.id`
  via `requireAuth`.
- JWT obtained via
  `Supabase.instance.client.auth.currentSession?.accessToken`.
- `conversation_history` is optional; defaults to empty array if omitted.
- `message` and `client_id` are required.

### §2.1.1 — Test fixtures for Flutter integration

Error fixtures verified against the current handler source (`server.js` →
`/cue-reasoning` + `middleware/requireAuth.js`). Adjust as the handler evolves.

**Successful request (200):**

```bash
curl -i -X POST https://cue-ai-proxy.onrender.com/cue-reasoning \
  -H "Authorization: Bearer <valid-supabase-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"<owned-client-uuid>","message":"test query","conversation_history":[]}'
```

→ `HTTP 200`, Anthropic response body (the client extracts `content[0].text`).

**1. Missing auth (401):**

```bash
curl -i -X POST https://cue-ai-proxy.onrender.com/cue-reasoning \
  -H "Content-Type: application/json" -d '{}'
```

→ `HTTP 401`, `{"error":"Missing authorization header"}`

The 401 path has a second body — `{"error":"Invalid or expired token"}` —
emitted when the `Authorization` header is present but the JWT is rejected
by Supabase (expired, revoked, or signature mismatch). A third body —
`{"error":"Auth verification failed"}` — covers exceptions during JWT
verification (network failure reaching Supabase, etc.). Flutter should
treat all three 401 bodies as "Session expired, please sign in again".

**2. Stray `slp_id` (400):**

```bash
curl -i -X POST https://cue-ai-proxy.onrender.com/cue-reasoning \
  -H "Authorization: Bearer <valid-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"slp_id":"abc","client_id":"<uuid>","message":"test"}'
```

→ `HTTP 400`, `{"error":"slp_id is no longer accepted in request body; it is derived from the authenticated session. Update your client to remove this field."}`

**3. Missing `client_id` (400):**

```bash
curl -i -X POST https://cue-ai-proxy.onrender.com/cue-reasoning \
  -H "Authorization: Bearer <valid-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}'
```

→ `HTTP 400`, `{"error":"client_id is required"}`

There is also a sibling 400 body — `{"error":"message (string) is required"}` —
emitted when `message` is absent, empty, or not a string.

**4. Unauthorized client access (403):**

```bash
curl -i -X POST https://cue-ai-proxy.onrender.com/cue-reasoning \
  -H "Authorization: Bearer <valid-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"<uuid-not-owned-by-this-slp>","message":"test"}'
```

→ `HTTP 403`, `{"error":"Client not found or access denied"}`

**5. Payload too large (413):**

```
[curl with conversation_history exceeding 32 KB]
```

→ `HTTP 413`, `{"error":"Payload Too Large — /cue-reasoning body is capped at 32 KB"}`

A reproducible one-liner that produces a ~33 KB body:

```bash
python3 -c 'import json; print(json.dumps({"client_id":"00000000-0000-0000-0000-000000000000","message":"x","conversation_history":[{"role":"user","content":"x"*33000}]}))' \
  | curl -i -X POST https://cue-ai-proxy.onrender.com/cue-reasoning \
      -H "Authorization: Bearer <valid-jwt>" \
      -H "Content-Type: application/json" \
      --data-binary @-
```

**Server-side handler check order** (knowing this avoids surprises when
multiple things are wrong with a request):

1. `requireAuth` middleware → 401 if header missing/invalid
2. Body size > 32 KB → 413
3. Body contains `slp_id` → 400 (stray-field rejection)
4. `message` missing/empty/non-string → 400
5. `client_id` missing → 400
6. Combined ownership-and-fetch query → 403 if no row, 500 if DB error
7. `slp_profiles.response_style` lookup (soft-fails to `'balanced'`)
8. Anthropic API call → upstream status passed through on Anthropic errors

## 3. Session-notes RAG

The `{session_context}` placeholder in the Cue Reasoning prompt is
currently filled with an empty string. Once the session-notes retrieval
pipeline lands, wire it into `/cue-reasoning` (the TODO comment in
`server.js` marks the call site).

## 4. /cue-study authentication audit

`/cue-study` is currently unauthenticated and performs no ownership
check on `chart_context`. This is an inherited pattern, not a new
issue, but it surfaces chart data to the AI under the same DPDP Act
2023 sensitivity bar that motivated hardening `/cue-reasoning`.

Before production, review and likely gate `/cue-study` with
`requireAuth` plus an ownership check on the `client_id` it operates
against. Worth fixing alongside the `/cue-reasoning` hardening rather
than letting the gap drift.
