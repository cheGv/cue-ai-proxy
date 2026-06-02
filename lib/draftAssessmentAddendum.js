// lib/draftAssessmentAddendum.js
//
// Step 4 — assessment data bridge. Drafter system-prompt addendum, appended to
// FORMAT_DRAFT_SYSTEM_PROMPT ONLY when /format-draft receives a canonical_data
// that carries an `assessment` block (the output of Cue's assessment bridge:
// CAS / voice / ped-dysarthria / ALD readers -> assembleAssessmentContext).
//
// Exactly like lib/draftSlotAddendum.js, this ADDS rules; it does NOT replace
// or relax the locked anti-fabrication prompt (Rule 1 stands). A therapy /
// session-report draft has no `assessment` block, so this text is never
// appended and that path's system prompt is byte-identical to before.
//
// v2 (2026-06-02): adds rule A5 — demographic identity (the Client Information
// Block: name / age / caregiver presence, drawn from canonical_data.client_meta)
// is tagged source_type "client_meta", so provenance is honest instead of
// mislabelling demographics as a clinical "substrate" source. Prompt-only, no
// code/DB enum gate (same as "assessment"). The therapy path stays byte-identical.
//
// Per the proxy's prompt-discipline: the addendum is versioned and carries a
// SHA256 of its exact text, both logged per call (server.js) for provenance.

const crypto = require('crypto');

const FORMAT_DRAFT_ASSESSMENT_ADDENDUM_VERSION = 'assessment-addendum-v2.2026-06-02';

const FORMAT_DRAFT_ASSESSMENT_ADDENDUM = `ASSESSMENT MODE — ACTIVE because canonical_data contains an "assessment" block.

This report is built from a point-in-time clinical ASSESSMENT, not from therapy sessions. canonical_data.assessment has this shape:

{
  "protocol": "<assessment protocol, e.g. pediatric-cas | voice>",
  "assessment_id": "<uuid>",
  "findings":  [ { "source_id", "source_table", "field_label", "value", "group" }, ... ],
  "measures":  [ { "source_id", "label", "value", "unit", "group" }, ... ]
}

The following rules ADD TO — and never relax — every rule already stated above:

A1. assessment.findings and assessment.measures are the ONLY clinical sources for this draft. The therapy primitives (sessions, substrate_cells, long_term_goals, short_term_goals, citations, metrics) are intentionally empty for an assessment draft; do NOT draw any clinical claim from them.

A2. Map each finding and measure into the locked template's section whose clinical scope matches the item's "group" (e.g. group "ASHA consensus markers" -> the markers / observations section; "Aerodynamic measures" -> the acoustic / aerodynamic section). A template section with no matching findings or measures receives NO clinical content.

A3. For EVERY clinical claim you write, add a source_claims entry:
    - "source_type": "assessment"   (the correct source_type in this mode; it extends the source_type set named earlier)
    - "source_id": the EXACT source_id of the finding or measure you drew from (e.g. "voice_assessments/<id>/laryngeal_exam_payload.mucosal_wave_amplitude")
    - "claim_text": the text in your content that states the claim
    - "source_excerpt": the finding's value (with its field_label / label) that supports the claim

A4. Reaffirming Rule 1 (this does NOT replace it): every clinical claim MUST trace to a specific finding or measure in the assessment block. Use each "value" exactly as captured — never re-interpret, soften, or embellish it (a value of "absent", "no", "0", or "Absent" is a real clinical finding, not a blank). If a section or group has NO findings or measures, leave that section blank or keep its template placeholder. Do NOT invent content, and do NOT write "N/A", "Not assessed", "[Not applicable]", or any filler to occupy an empty section. A blank section is the correct, honest output.

A5. Client identification details — the Client Information Block (the client's name, age, caregiver presence, and similar demographic facts) — come from canonical_data.client_meta, NOT from assessment.findings / assessment.measures and NOT from the (empty) therapy primitives. They are identity, not clinical findings. When you state such a demographic fact, add a source_claims entry with:
    - "source_type": "client_meta"   (a distinct value for client_meta-derived demographics; like "assessment" it extends the source_type set and is prompt-only — no code or database enum gates it)
    - "source_id": the client_meta field you drew from (e.g. "client_meta.client_name", "client_meta.age", "client_meta.caregiver_present")
    - "claim_text": the text in your content that states the demographic fact
    - "source_excerpt": the client_meta value that supports it
   Do NOT tag demographics as "assessment" (they are not clinical findings), and do NOT tag them as "substrate" (the substrate primitive is empty in this mode). client_meta is the ONLY non-finding source permitted, and ONLY for this demographic identity content; every CLINICAL claim still follows rules A1 to A4.

A6. All other rules stand unchanged: the template's voice register, the SLP's lexicon_defaults and Cue's neutral replacements, section length conventions, and the required output shape (the JSON array of sections — plus the slot_content object if slot-fill mode is also active).`;

const FORMAT_DRAFT_ASSESSMENT_ADDENDUM_SHA256 =
  crypto.createHash('sha256').update(FORMAT_DRAFT_ASSESSMENT_ADDENDUM, 'utf8').digest('hex');

// Append the assessment addendum block to the drafter's `system` array when in
// assessment mode. PURE. When NOT in assessment mode it returns the SAME array
// (unchanged reference + contents) so the therapy / slot-fill system payload is
// byte-identical. When in assessment mode it returns a NEW array (input never
// mutated) with the addendum as the LAST block — so it stacks cleanly after the
// base prompt and (if present) the slot addendum.
function appendAssessmentAddendum(systemBlocks, assessmentMode) {
  if (!assessmentMode) return systemBlocks;
  return systemBlocks.concat([
    { type: 'text', text: FORMAT_DRAFT_ASSESSMENT_ADDENDUM, cache_control: { type: 'ephemeral' } },
  ]);
}

module.exports = {
  FORMAT_DRAFT_ASSESSMENT_ADDENDUM,
  FORMAT_DRAFT_ASSESSMENT_ADDENDUM_VERSION,
  FORMAT_DRAFT_ASSESSMENT_ADDENDUM_SHA256,
  appendAssessmentAddendum,
};
