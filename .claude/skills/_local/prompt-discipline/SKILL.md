# Skill: prompt-discipline
> **Proxy repo** (`C:\dev\cue\proxy`, `cheGv/cue-ai-proxy`). This is where Cue's most important governance actually executes — the system prompts that must obey `language-discipline` live here. A prompt change here is a clinical-voice change.
## When to use
Triggered by any change to a system prompt, an Edge Function / proxy endpoint, `routes/generateGoals.js`, `server.js`, or anything Node-side that shapes what the LLM produces.
## FIRST: read the shared laws — they govern prompts as much as code
The shared-core skills are canonical in the **Flutter repo** at `C:\projects\cue\.claude\skills\_shared\`:
- **`language-discipline`** — governs every word these prompts emit. The §13.x rules are not Flutter-only; they are *primarily* prompt rules. Read it before touching any clinical prompt.
- **`clinical-invariants`** — anti-hallucination, attestation, controlled vocabularies, multilingual fidelity.
- **`product-law`** and **`north-star`** — the why.
Do NOT duplicate those skills into the proxy repo (drift trap — see `repo-and-path-topology`). Read them from the Flutter path.
## The proxy AI invariants
### A1. Anti-fabrication is the immutable preamble
Every clinical-generation prompt prepends the anti-fabrication system prompt. It is loaded from a versioned file, never inlined. A feature cannot opt out. (Clinical rule: `clinical-invariants`; this is the proxy enforcement.)
### A2. The proxy is the security + de-identification boundary
- The proxy holds the Anthropic API key; the Flutter client never sees it.
- PHI is de-identified in the request body before forwarding to Anthropic (patient/family names, addresses, identifiable detail → opaque tokens); re-identified client-side after. Child clinical observations are the signal — keep them; identifiers go.
- Flutter calls the proxy via plain `http.post` to Render, **never** `functions.invoke()` (resolved JWT ES256/HS256 mismatch — reintroducing it reopens the bug).
### A3. Structured output for anything DB-bound
LLM responses parsed and persisted use a structured/JSON schema, not regex on free text. Schema lives in a versioned file alongside the prompt; validated at the proxy boundary.
### A4. "Insufficient information" round-trips
When the model lacks grounding, it returns a structured "not documented" / insufficient-info response (`clinical-invariants`) — never silently coerced to empty string, null, or a fabricated default downstream.
### A5. AI success bar
SLPs edit <10% of generated content. High edit rate = the prompt is failing the Product Law (making the SLP redo the system's work). Treat rising edit rate as a prompt bug.
## Prompt review discipline (§16.1)
Every system prompt gets a **partner-mode review pass before deploy.** Review covers:
- enum coverage gaps
- undefined field semantics
- unbounded output lengths
- code-mixed Indian clinical-note handling (Telugu/Kannada/Hindi/English — preserve, never translate child productions)
- trust calibration (confidence honesty over false certainty)
- invariant pairings (sentinel values paired across fields)
- design-spine alignment for any UI artifact the prompt drives
- **`language-discipline` conformance** — run the §13 forbidden-words scan and stance check against the prompt's output templates
Review writeups stored in `/prompts/reviews/` alongside the prompt artifact.
**Every prompt is single-sourced via a `DETECTOR_VERSION` (or equivalent) constant + a SHA256 hash of the prompt string, both logged on every API call.** Version bumps without prompt changes (or prompt changes without version bumps) are caught at log inspection.
## The persistence contracts (proxy ↔ DB)
These are the bridge between `language-discipline` §13.3/§13.13 and the database. The proxy owns them:
- **Goal Part A** → `long_term_goals.goal_text` (and `short_term_goals.specific`). 25–35 words, action-first, ≤22 words per sentence (§13.12).
- **Goal Part B / conditions** → appended to `long_term_goals.notes` and `short_term_goals.original_text`. Either the legacy `Conditions:`-prefixed prose OR the structured object (`queued_activities` / `suitable_instruments` / `discretion_close`) JSON-stringified into the same TEXT column. **No new DB column.** Readers must accept both shapes.
- The three clinical-coherence rules (§13.3), the instrument-menu pattern (§13.9), the humility close (§13.11), and the structured-conditions shape (§13.13) are **mirrored between this prompt and `language-discipline`** — change one, change both, in lockstep.
## Anti-rationalizations
| Excuse | Counter |
|---|---|
| "Language rules are a Flutter concern." | They're primarily prompt rules. The proxy is where they execute. Read `language-discipline`. |
| "I'll inline this prompt, it's short." | Versioned file + SHA256 hash logged. No inline prompts. |
| "I'll bump the prompt without the version constant." | Version + hash must move together or log inspection can't catch drift. |
| "functions.invoke() is the normal Supabase path." | Reopens the JWT mismatch. http.post to Render. |
| "The model's confident, skip the structured schema." | DB-bound output uses a schema. Confidence isn't correctness in clinical text. |
| "I changed the goal structure here; the skill can catch up later." | Mirror it in `language-discipline` in the same change. Lockstep, always. |
## Evidence of compliance
- Prompt change mirrored in `language-discipline` (state which §).
- Review writeup in `/prompts/reviews/`.
- Version constant + SHA256 hash updated and logged.
- Forbidden-words scan + stance check run against output templates.
- De-identification confirmed: no PHI in the forwarded prompt body.
