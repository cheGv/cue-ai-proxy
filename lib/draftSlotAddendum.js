// lib/draftSlotAddendum.js
//
// Phase D week 3 — Cue Mirror content-slot bridge: drafter system-prompt
// addendum. Appended to FORMAT_DRAFT_SYSTEM_PROMPT only when the /format-draft
// request carries a slot_map. It does NOT replace or relax any existing content
// discipline (source-grounding, lexicon defaults, voice register, length
// conventions, static-authored sections) — it adds a SECOND output
// representation (slot_content) derived from the SAME content generation, so
// the new geometric renderer can fill the clinician's exact format while
// draft_sections continues to feed Component Three + the sentence corpus.

const FORMAT_DRAFT_SLOT_ADDENDUM = `SLOT-FILL MODE — ACTIVE because the INPUT contains a slot_map.

In addition to the section array, you will fill a content-slot map so the report can be rendered into the clinician's EXACT original visual format. Change your output from a bare JSON array to a single JSON OBJECT with EXACTLY two top-level keys:

{
  "sections": [ ...the SAME section array you would otherwise produce, identical in shape and obeying every rule above... ],
  "slot_content": { "<slot_id>": <value>, ... }
}

INPUT.slot_map.slots is an array of { slot_id, semantic_label, repeatable_per_skill_domain, notes }. Fill slot_content as follows:

1. Produce an entry for EVERY slot in slot_map.slots, keyed by its slot_id.
2. NON-repeatable slot (repeatable_per_skill_domain = false): the value is a STRING — the content for that single location (e.g. client_name -> the client's name; provisional_diagnosis -> the diagnosis text; a date slot -> the date string, or "" if unknown).
3. REPEATABLE slots (repeatable_per_skill_domain = true) all belong to ONE table body row that repeats once per skill domain. Their values are ARRAYS, ALIGNED BY INDEX: entry i of every repeatable slot describes the SAME domain i. Choose one domain per short-term goal / skill area in canonical_data, in goal sequence order. So row_skills[i], row_goals[i], row_activities[i], row_progress_report[i] all describe domain i, and all repeatable arrays MUST have the same length.
4. If a slot's notes say 'Label prefix: X', output ONLY the value, never the label — the template already carries the label verbatim.
5. Every clinical claim in slot_content obeys ALL the rules already stated (source-grounding to canonical_data, lexicon defaults + neutral replacements, the template voice register, length conventions). slot_content and sections are TWO representations of ONE content generation and MUST NOT contradict each other.
6. If content for a slot is genuinely unavailable in canonical_data, output "" (empty string); for a repeatable domain keep the arrays aligned with "" rather than dropping an index. NEVER invent unsourced clinical claims to fill a slot.

7. The template's voice register is a soft default. When the template's intended population differs from the actual client's profile (e.g., pediatric template applied to adult client, or vice versa), adapt pronouns and client references appropriately. Substitute 'the child' with the client's name or 'the patient' when clinically warranted. Preserve all other voice characteristics (verb constructions, sentence patterns, technique description style).

8. Narrative templates (e.g. a pre-therapy assessment) have many paragraph slots and small mini-table cells; fill each the same way — a STRING value per slot_id (these are NOT repeatable). A narrative report often has whole sections with NO data for THIS client (e.g. an articulation client has no prenatal/birth/developmental history; an adult has no pediatric milestones). For any slot whose content is not present in canonical_data, output "" (empty string) — the renderer keeps the template's own placeholder text for that location. NEVER write "N/A", "[Not applicable]", "Not assessed", or any invented filler to occupy an empty slot; "" is the correct, honest output. Fill ONLY what the substrate genuinely supports.

Output ONLY the single JSON object. No prose, no markdown fences.`;

module.exports = { FORMAT_DRAFT_SLOT_ADDENDUM };
