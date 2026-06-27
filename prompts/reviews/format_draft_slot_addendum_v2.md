# Format-Draft Slot Addendum — v2 review

**Status:** committed 2026-06-27 to branch `proxy-hard-facts-placed-not-inferred` (off `fc77762`); NOT merged to main, NOT deployed. Targets `POST /format-draft` on the Render proxy.
**Spec lineage:** v1 (unversioned slot-fill addendum, Phase D wk3) → v2 (this artifact — adds hard-facts source-grounding rule 9 + introduces version/hash tracking for a previously-unversioned prompt).
**CLAUDE.md anchor:** §16.1 Prompt Review (doctrine); proxy `_local/prompt-discipline` invariant **A6** (Hard facts are placed, not inferred). Doctrinal parent: `_shared/clinical-invariants` (anti-hallucination).

This file is the canonical record of what the v2 addendum change contains. Per §16.1 it lives alongside the prompt artifact in `prompts/reviews/`.

---

## 1. Staged configuration

| Field | Value | Source |
|---|---|---|
| Endpoint | `POST /format-draft` | `server.js` (handler at ~line 2426) |
| Prompt artifact | `FORMAT_DRAFT_SLOT_ADDENDUM` (slot-fill mode only) | `lib/draftSlotAddendum.js` |
| Auth | `requireAuth` middleware (Bearer JWT) | `middleware/requireAuth.js` |
| Model | `claude-opus-4-5` | `server.js` (unchanged by v2) |
| Cache control | `cache_control: { type: 'ephemeral' }` on each system block | `server.js` (FORMAT_DRAFT_SYSTEM_PROMPT + addendum) |
| Activation | slot-fill mode — only when the template's `format_slot_map` has ≥1 slot | `server.js` (`slotFill = !!slotMap`) |
| Addendum version | `FORMAT_DRAFT_SLOT_ADDENDUM_VERSION = 'v2'` (single-sourced const) | `lib/draftSlotAddendum.js` |
| Prompt drift detection | `FORMAT_DRAFT_SLOT_ADDENDUM_HASH = '71d4c5d7'` — first 8 hex of SHA256 of the addendum string | `lib/draftSlotAddendum.js` |
| Where logged | `generation_metadata.slot_addendum_version_snapshot { version, prompt_hash }`, written per call when slot-fill is active (`null` otherwise) | `server.js` (handler metadata block) |
| Schema change | **none** — folds into the existing `format_drafts.generation_metadata` JSON column (B-min) | — |

---

## 2. The v2 change

### 2a. New rule 9 — hard facts are placed, not inferred

The addendum's numbered rule list gained a rule 9, inserted after rule 8 and before the closing `Output ONLY…` line:

> 9. HARD CLINICAL FACTS — diagnosis, ages, scores, dates — must come DIRECTLY from a value present in canonical_data. NEVER infer a hard fact from adjacent or structural data. In particular, assessment.protocol is a routing label (which form was opened), NOT a diagnosis — it is NEVER a source for provisional_diagnosis. If no explicit diagnosis value exists in canonical_data, output "". A sourceless hard fact stays empty; inference is fabrication.

This is a **proxy-local source-grounding guard**, not a §13 language-discipline change. It alters no word choice, voice, register, stance, or goal/conditions shape — only *whether a hard fact may be emitted at all, given its provenance*. Confirmed during recon against the enumerated §13 lockstep set (§13.3 / §13.9 / §13.11 / §13.13); rule 9 touches none of them, so **no `_shared/language-discipline` mirror is required.** Its doctrinal parent is `_shared/clinical-invariants` (anti-hallucination). The governance principle is recorded as invariant **A6** in `_local/prompt-discipline`; rule 9 is the executing guard A6 answers to (internal proxy pairing, both edited in this change).

### 2b. Introducing versioning for a previously-unversioned prompt (B-min)

Before v2, `FORMAT_DRAFT_SLOT_ADDENDUM` was a plain exported string with **no version constant and no SHA256 hash** — the only prompt in the proxy with execution-shaping clinical rules that was not single-sourced via version+hash (the domain detector being the reference pattern). Per the persistence-contract discipline, a versioned prompt change cannot ship a rule edit without a version/hash to log. v2 closes that gap with the minimal mechanism:

- `FORMAT_DRAFT_SLOT_ADDENDUM_VERSION = 'v2'` and `FORMAT_DRAFT_SLOT_ADDENDUM_HASH` (sha256, first 8 hex) added to `lib/draftSlotAddendum.js`, both exported.
- The `/format-draft` handler logs them into the existing `generation_metadata` as `slot_addendum_version_snapshot`. No new column, no migration.
- Going forward: bump `VERSION` whenever the addendum string changes; `HASH` recomputes automatically. Version-without-hash-move (or vice versa) is caught at log inspection, exactly as for the domain detector.

---

## 3. The observed bug this guards (protocol → diagnosis leak)

On the CAS format-fill test, the model emitted a **stated provisional diagnosis with no clinician source**:

- `slot_content.provisional_diagnosis = "Childhood Apraxia of Speech"` — written as an attested diagnosis.
- The case's `canonical_data` carried **no clinician-entered diagnosis value**. The only signal was the assessment **routing label** (`assessment.protocol = pediatric-cas` — i.e. *which assessment form was opened*), which the model treated as if it were a diagnosis.

A routing/triage label says *which form the clinician opened*, not *what the clinician concluded*. Promoting it to a stated diagnosis fabricates a hard clinical fact the clinician never entered — precisely the failure A6/rule 9 forbid. Correct behavior under rule 9: with no explicit diagnosis value in `canonical_data`, `provisional_diagnosis` stays `""` and the renderer keeps the template's own placeholder.

---

## 4. Enforcement status & verification

| Item | Status |
|---|---|
| Prompt-level guard (rule 9) | Staged in `FORMAT_DRAFT_SLOT_ADDENDUM`; depends on model compliance until the resolver lands |
| Deterministic resolver | **Planned** — the durable, code-level enforcement: a proxy-side resolver that refuses to map `assessment.protocol` (or any routing/structural label) into a hard-fact slot, independent of model behavior. Not in this change. |
| Version/hash mechanism | `v2` / `71d4c5d7`, logged per call in `generation_metadata.slot_addendum_version_snapshot` |
| Suite | Full proxy `node --test` run — see §6 |
| Schema migration | none required (B-min) |

---

## 5. Cross-references

| Reference | Where |
|---|---|
| Governance invariant A6 | `C:\dev\cue\proxy\.claude\skills\_local\prompt-discipline\SKILL.md` |
| Executing guard (rule 9) | `C:\dev\cue\proxy\lib\draftSlotAddendum.js` |
| Version/hash logging | `C:\dev\cue\proxy\server.js` (`/format-draft` handler, `generation_metadata`) |
| Doctrinal parent (anti-hallucination) | `C:\projects\cue\.claude\skills\_shared\clinical-invariants\SKILL.md` |
| Reference version+hash pattern | `C:\dev\cue\proxy\server.js` (domain detector — `DOMAIN_DETECTOR_VERSION` / `DOMAIN_DETECTOR_PROMPT_HASH`) |
| House-format precedent | `prompts/reviews/domain_detector_v1.3.2.md` |

---

## 6. Known limitations

- **Prompt-level guard depends on model compliance.** Rule 9 instructs the model not to infer hard facts, but a prompt instruction is not a hard constraint — a non-compliant generation can still emit a sourceless diagnosis. The **deterministic resolver** (§4) is the planned code-level enforcement that makes the guard independent of model behavior; until it lands, rule 9 is best-effort.
- **The base `FORMAT_DRAFT_SYSTEM_PROMPT` remains unversioned.** v2 versions only the slot-fill addendum. The base prompt still has no version/hash; `slot_addendum_version_snapshot` is `null` on non-slot-fill (legacy) calls. Versioning the base prompt is a separate, deferred change.
- **No fixture harness for `/format-draft` yet.** Unlike the domain detector, this endpoint has no committed fixture suite asserting the protocol→diagnosis case stays empty. The CAS case in §3 was observed manually; codifying it as a fixture is recommended alongside the resolver.

---

*End of v2 review. The next material revision (resolver landing, or base-prompt versioning) gets its own file in this directory.*
