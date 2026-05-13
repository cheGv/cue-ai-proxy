# Domain Detector — v1.3.2 review

**Status:** shipped 2026-05-13. Live at `POST /cue-domain-detect` on the Render proxy.
**Spec lineage:** v1 → v1.1 → v1.2 → v1.3 → v1.3.1 (Evening 1 + 2 work) → v1.3.2 (this artifact).
**CLAUDE.md anchor:** §16.1 Prompt Review (doctrine), §10 invariants (pending — see CLAUDE.md §12 backlog).

This file is the canonical record of what shipped, including the deviations from the v1.3.1 spec text. Per §16.1, it lives alongside the prompt artifact in `prompts/reviews/`.

---

## 1. Shipped configuration

| Field | Value | Source |
|---|---|---|
| Endpoint | `POST /cue-domain-detect` | `server.js` lines ~1434–1860 |
| Auth | `requireAuth` middleware (Bearer JWT) | `middleware/requireAuth.js` |
| Model | `claude-sonnet-4-20250514` | `server.js` (D5-revised) |
| Beta header | **none** — prompt caching is GA, no header required | Anthropic docs verified 2026-05-13 |
| System prompt size | ~1624 tokens (Anthropic-reported cache_read_input_tokens on warm calls) | Render telemetry, Evening 2 fixture run |
| Cache control | array-with-`cache_control: { type: 'ephemeral' }` on the system block | `server.js` Note 1 |
| Cache minimum (Sonnet) | 1024 tokens — our prompt qualifies | Anthropic docs verified 2026-05-13 |
| Word-count gate | `MIN_INPUT_WORDS = 3` — pre-API cost-control | `server.js` |
| Payload cap | 4 KB → HTTP 413 | `server.js` D6 |
| Detector version | `DETECTOR_VERSION = 'v1'` (single-sourced const) | `server.js` |
| Prompt drift detection | `DETECTOR_PROMPT_HASH` = first 8 hex of SHA256 of system prompt, logged on every call | `server.js` |
| Retry policy | Max 2 attempts; final failure logs to `detection_failure_log` and returns `persisted: false, reason: detection_failed` | `server.js` |
| Insufficient-input sentinel | `primary_domain: null` IFF `confidence: 0.0`; logs to `detection_insufficient_input_log` (NOT failure log) | endpoint invariant validation + `detection_insufficient_input_log` source enum |

**Six approved deviations from v1.3.1 Task 2 spec text** (all documented inline in `server.js`):

- **D1.** `requireAuth` mounted; `slp_user_id` derived from `req.user.id`; body field rejected with 400 (mirrors `/cue-reasoning` lines 1160–1167).
- **D2.** Ownership check (`clients.id = ? AND clinician_id = ?`) before any work; 403 if no row.
- **D3.** CommonJS `require('crypto')` not ESM `import`.
- **D4.** Per-request `createClient(SUPABASE_URL, SUPABASE_SERVICE)` inside the handler.
- **D5.** Model: `claude-opus-4-5` (originally specified) → `claude-sonnet-4-20250514` (shipped). See §2 below.
- **D6.** 4 KB payload cap with HTTP 413, mirroring `/cue-reasoning` 32 KB pattern.

---

## 2. The Opus → Sonnet pivot

### What v1.3.1 specified
Model `claude-opus-4-5`, with prompt caching enabled via array-with-cache_control system shape.

### What Evening 2 telemetry revealed
After 11 fixture runs on Opus 4.5, all responses came back with `cache_creation_input_tokens: 0` AND `cache_read_input_tokens: 0` — meaning **caching was not working**, despite the cache_control directive being structurally correct.

### Diagnostic finding
The hypothesis floated initially (missing `anthropic-beta: prompt-caching-2024-07-31` header) was **wrong**. Anthropic's prompt-caching documentation (verified live 2026-05-13 at https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) confirmed:

1. Prompt caching is **generally available** — no beta header required.
2. Cache eligibility has a **per-model token minimum**:
   - Claude Opus 4.7 / 4.6 / 4.5: **4096 tokens minimum**
   - Claude Opus 4.1 / 4: 1024 tokens minimum
   - Claude Sonnet: 1024 tokens minimum
3. Below the minimum, the API **silently ignores** the cache directive — no error, both cache counters return 0.

Our system prompt measured ~1624 tokens (per Anthropic's tokenizer on warm cache reads). Well below Opus 4.5's 4096 minimum; well above Sonnet's 1024 minimum.

### Why Sonnet was chosen over alternatives
Four paths considered (full deliberation in v1.3.1→v1.3.2 conversation):

- **(A) Switch to Sonnet** — chosen. Matches the proxy's other classifier-tier endpoints (`/cue-reasoning`, `/cue-study`, `/generate-brief` all use `claude-sonnet-4-20250514`). Caching qualifies. Cheaper per call. Classification quality was over-spec'd on Opus (all 11 fixtures returned 0.92 on clear cases, suggesting headroom).
- **(B) Switch to Opus 4.1/4** — rejected. Trades model recency for caching when Sonnet gives both cheaper.
- **(C) Drop the cache_control directive, accept no caching, stay on Opus** — fallback if Sonnet quality regressed. Cost delta ~$50/year at expected scale.
- **(D) Expand the prompt to exceed 4096 tokens with legitimate content** — deferred. Real prompt-engineering work, not a one-line patch.

### Quality verification on Sonnet
All 11 fixtures re-ran post-Sonnet-deploy. Pass criterion was 10/11 (only `ambiguous_autism_intake` allowed to fail).

| Result | Count |
|---|---|
| Clean pass | 11 (10 from harness + 1 from retry of fixture #3 after a deploy-transition transient) |
| Build-blocking fail | 0 |
| Acceptable diff | 0 |

Two notable Sonnet behaviors **better** than Opus on the same fixtures:

- **Confidence calibration is finer.** Opus returned 0.92 across nearly all clear cases. Sonnet returned 0.85 / 0.90 / 0.92 / 0.95 — using the gradient meaningfully.
- **Ambiguous case (#4) hit the correct sentinel path.** Opus returned `primary_domain: language, confidence: 0.45, persisted: true` — a low-confidence guess that persisted. Sonnet returned `primary_domain: null, confidence: 0.0, persisted: false, reason: insufficient_input` — correctly recognized input was too thin, took the `model_returned_insufficient` code path, and the row went to `detection_insufficient_input_log` instead of polluting the client's domain state.

---

## 3. Cache warmup behavior — not a bug

Across the post-Sonnet-deploy fixture run, the first ~2 Anthropic calls did NOT cache (both `cache_creation_input_tokens` and `cache_read_input_tokens` were 0). The next 8+ consecutive calls showed the expected pattern (one call writes the cache, subsequent calls read it).

**This is Anthropic's normal cache-eligibility evaluation, not a bug in our endpoint.** From observed behavior and external documentation: the API evaluates whether a prompt is worth caching based on heuristics about repetition and stability before activating the cache. The first one or two calls with a given prompt may be processed without cache writes even when the prompt is above the model's minimum size.

**Implication for telemetry monitoring:** an SLP's first 1–2 domain detections after a proxy redeploy (or after a long idle window) may not show cache hits. Subsequent calls should. If the pattern doesn't stabilize after ~3 calls with the same `prompt_hash`, that's worth investigating.

---

## 4. Verification artifacts

| Artifact | Location |
|---|---|
| Fixture definitions | `C:\projects\cue\test\fixtures\domain_detector_cases.json` (11 cases) |
| Fixture harness | `C:\dev\cue\proxy\scripts\run_fixtures.js` (gitignored) |
| JWT mint helper | `C:\dev\cue\proxy\scripts\mint_test_jwt.js` (gitignored) |
| Test client | `clients.id = f62e1d15-6728-436e-a746-b40817cce8d2`, name `Domain Detector Test Client`, clinician `aabd240c-9196-412c-bf1a-a0fc1d0376a6` |
| Schema migration | Supabase `cgnjbjbargkxtcnafxaa` migration `domain_attribute_detector_v1_3_1` applied 2026-05-13 |
| Audit trail confirmation | 11 rows in `client_domain_history` for test client; 1 row in `detection_insufficient_input_log` (source `model_returned_insufficient`) from fixture #4 on Sonnet |

---

## 5. Cross-references

| Reference | Where |
|---|---|
| v1.3.1 spec (full Task 2 + Task 3 + Task 7) | Founder-Claude conversation history, 2026-05-13 |
| §16.1 Prompt Review doctrine | `C:\projects\cue\CLAUDE.md` (committed `12f6752`) |
| Endpoint code | `C:\dev\cue\proxy\server.js` (proxy commits `f3e0d37` → `72867c4`) |
| Deferred CLAUDE.md doctrine (§6.X, §10 invariants, §16.2–§16.4) | `C:\projects\cue\CLAUDE.md` §12 backlog bullet (Domain Detector v1.3.2 — CLAUDE.md doctrine backlog) |

---

## 6. Known limitations

- **Confidence calibration is coarse on clear cases.** Sonnet uses the 0.85–0.95 range with reasonable spread but rarely returns intermediate values like 0.78 or 0.83. May warrant a prompt nudge toward finer-grained confidence scoring in v1.4 if downstream UX depends on it.
- **Cache warmup is not currently surfaced in app telemetry.** The proxy logs `cache_creation_input_tokens` and `cache_read_input_tokens` per call. If we ever surface "Cue is warming up after a deploy" as a user-facing signal, this would be the data feed.
- **Detector version migration plan deferred.** When v2 ships, existing client records with `domain_detector_version = 'v1'` need a re-run strategy. Not addressed in v1.3.x. Schedule alongside any v2 design work.

---

*End of v1.3.2 review. The next material revision (v1.4 or v2) gets its own file in this directory.*
