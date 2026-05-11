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
