const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;

// Phase 4.0.7.23c-deploy — load Cue v2 system prompt at module load.
// Strip the leading HTML comment header (authoring metadata block at
// the top of the .md file) before passing to the LLM. v1 lives at
// prompts/system_prompt_v1.md, archived but not loaded.
const SYSTEM_PROMPT_RAW = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'system_prompt_v2.md'),
  'utf8'
);
const SYSTEM_PROMPT = SYSTEM_PROMPT_RAW
  .replace(/^<!--[\s\S]*?-->\s*/, '')
  .trim();

router.post('/generate-goals', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = authHeader.split(' ')[1];

  const userClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const {
    client_id,
    clarifying_answers,
    clinical_area,
    clinical_area_label,
    previous_clarifying_question,
    clarifying_response,
  } = req.body;

  if (!client_id) {
    return res.status(400).json({ error: 'client_id is required' });
  }
  if (!clarifying_answers && !clinical_area) {
    return res.status(400).json({ error: 'clinical_area (or legacy clarifying_answers) is required' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE);

  try {
    const [clientRes, sessionsRes, goalsRes, frameworksRes] = await Promise.all([
      db.from('clients').select('*').eq('id', client_id).single(),
      db.from('clinical_sessions')
        .select('id, session_date, soap_note, session_summary, goals_addressed')
        .eq('client_id', client_id)
        .order('session_date', { ascending: false })
        .limit(10),
      db.from('goals')
        .select('goal_text, domain, status')
        .eq('client_id', client_id)
        .eq('status', 'active'),
      clinical_area
        ? db.from('frameworks')
            .select('short_code, name, description, key_authors, evidence_level, when_to_use')
            .contains('domains', [clinical_area])
        : Promise.resolve({ data: [], error: null })
    ]);

    if (clientRes.error) throw new Error(`Client fetch failed: ${clientRes.error.message}`);

    const client = clientRes.data;
    const sessions = sessionsRes.data || [];
    const existingGoals = goalsRes.data || [];
    const frameworks = frameworksRes.data || [];
    if (clinical_area) {
      console.log(`[generate-goals] clinical_area=${clinical_area}, ` +
                  `frameworks=${frameworks.length}`);
    }

    let ageYears = null, ageMonths = null;
    if (client.date_of_birth) {
      const dob = new Date(client.date_of_birth);
      const now = new Date();
      const totalMonths = (now.getFullYear() - dob.getFullYear()) * 12 + (now.getMonth() - dob.getMonth());
      ageYears = Math.floor(totalMonths / 12);
      ageMonths = totalMonths % 12;
    } else if (client.age) {
      ageYears = client.age;
      ageMonths = 0;
    }

    // First name = first whitespace token of clients.name. Source of
    // truth for the LLM's child-name rule (system_prompt_v2.md §CUE'S
    // VOICE) and for the post-generation scrubber below.
    const clientFullName = typeof client.name === 'string' ? client.name.trim() : '';
    const clientFirstName = clientFullName.split(/\s+/)[0] || '';

    const chartPayload = {
      client: {
        first_name: clientFirstName || null,
        age_years: ageYears,
        age_months: ageMonths,
        diagnosis: client.diagnosis ?? null,
        languages: client.languages?.length ? client.languages : client.primary_language ? [client.primary_language] : [],
        aac_status: client.aac_status ?? (client.uses_aac ? 'emerging' : 'none'),
        communication_modality: client.communication_modality ?? null,
        clinical_area: clinical_area ?? null,
        clinical_area_label: clinical_area_label ?? null
      },
      clarifying_answers: clarifying_answers ?? null,
      session_notes: sessions.map(s => {
        const date = s.session_date ? `(${s.session_date})` : '';
        return [s.soap_note, s.session_summary, s.goals_addressed].filter(Boolean).join(' ').trim() || `Session ${date}: No notes recorded`;
      }),
      assessments: existingGoals.length ? [`Existing active goals: ${existingGoals.map(g => g.goal_text).join('; ')}`] : [],
      intake_notes: client.additional_notes ?? null,
      clinician_hypothesis: req.body.clinician_hypothesis ?? null,
      framework_grounding: frameworks
    };

    // Phase 4.0.7.23c-deploy — clarifying-question round-trip. When the
    // SLP answers a prior clarifying question, both the question and
    // the answer are appended to the user message as plain text after
    // the JSON chart payload. v2 prompt picks them up naturally; no
    // prompt amendment required.
    let userMessage = JSON.stringify(chartPayload);
    if (previous_clarifying_question && clarifying_response) {
      userMessage += `\n\nEarlier you asked: "${previous_clarifying_question}"\nThe SLP answered: "${clarifying_response}"`;
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${errBody.slice(0, 200)}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text ?? '';

    let v2;
    try {
      const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      v2 = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ error: 'Cue returned malformed JSON', raw_preview: rawText.slice(0, 300) });
    }

    if (!v2 || typeof v2 !== 'object') {
      return res.status(502).json({
        error: 'Cue returned non-object response',
        raw: rawText.slice(0, 500),
      });
    }

    // Hallucination scrubber — deterministic post-generation safeguard.
    // The LLM occasionally puts an invented first name in subject
    // position ("Priya will…"). For every generated string we are about
    // to insert, replace any sentence-subject capitalised name token that
    // isn't the client's real first name with the real first name, or
    // "The client" if no real name is reliably available. Runs before
    // every return path so safeguarding_halt and awaiting_clarification
    // responses are also sanitised even though those paths don't write
    // goal rows. child_name_used is canonicalised here too — the raw
    // LLM claim never reaches the client; any defiance is logged.
    const SUBJECT_VERB_RE = /(^|[.!?]\s+)([A-Z][a-z]{1,19})(\s+)(will|is|has|can|may|shall|does|did|attempts?|attends?|engages?|produces?|uses?|communicates?|completes?|achieves?|demonstrates?|identifies|requests?|responds?|initiates?|imitates?|labels?|points?|gestures?|maintains?|tolerates?|reads?|writes?|speaks?|signs?|selects?|chooses?|begins?|continues?|stops?|reduces?|increases?|generalises?|generalizes?)\b/g;
    const scrubSubjectName = (text) => {
      if (typeof text !== 'string' || !text) return text;
      const replacement = clientFirstName || 'The client';
      const realLower = clientFirstName.toLowerCase();
      return text.replace(SUBJECT_VERB_RE, (m, prefix, candidate, ws, verb) => {
        if (realLower && candidate.toLowerCase() === realLower) return m;
        return `${prefix}${replacement}${ws}${verb}`;
      });
    };
    if (Array.isArray(v2.ltg_candidates)) {
      for (const ltg of v2.ltg_candidates) {
        if (ltg && typeof ltg === 'object') {
          if (typeof ltg.text === 'string') ltg.text = scrubSubjectName(ltg.text);
          if (typeof ltg.conditions_text === 'string') ltg.conditions_text = scrubSubjectName(ltg.conditions_text);
        }
      }
    }
    if (Array.isArray(v2.stg_candidates)) {
      for (const stg of v2.stg_candidates) {
        if (stg && typeof stg === 'object' && typeof stg.text === 'string') {
          stg.text = scrubSubjectName(stg.text);
        }
      }
    }
    {
      const rawClaim = typeof v2.child_name_used === 'string' ? v2.child_name_used.trim() : '';
      const sanitized = clientFirstName || 'the child';
      const isCompliant = !rawClaim
        || (clientFirstName && rawClaim.toLowerCase() === clientFirstName.toLowerCase())
        || (!clientFirstName && rawClaim.toLowerCase() === 'the child');
      if (!isCompliant) {
        console.warn(`[generate-goals] child_name_used defiance: client_id=${client_id} raw=${JSON.stringify(rawClaim)} sanitized=${JSON.stringify(sanitized)}`);
      }
      v2.child_name_used = sanitized;
    }

    // SAFEGUARDING HALT — v2's safeguarding return shape ([:166-174 in
    // system_prompt_v2.md). Persistence is recorded as a goal_plans row
    // with status 'safeguarding_halt' so the surface has a plan_id to
    // anchor the SLP's clarifying note. No LTGs/STGs/tags are written.
    if (v2.safeguarding_flag) {
      const { data: planRow, error: planErr } = await db
        .from('goal_plans')
        .insert({
          client_id: String(client_id),
          user_id: user.id,
          framework_router: null,
          router_confidence: null,
          clarifying_answers: clarifying_answers || {},
          reasoning_trace: null,
          data_sources: [],
          status: 'safeguarding_halt',
          safeguarding_flag: v2.safeguarding_flag,
        })
        .select()
        .single();

      if (planErr) {
        console.error('[generate-goals] safeguarding plan insert failed:', planErr);
        return res.status(500).json({ error: 'plan insert failed' });
      }

      return res.status(200).json({
        plan_id: planRow.id,
        safeguarding_flag: v2.safeguarding_flag,
        clarifying_question: v2.clarifying_question || null,
        domain: v2.domain || [],
        goals: [],
        pending_attestation: false,
      });
    }

    // CLARIFYING-QUESTION-ONLY — v2's WHEN UNCERTAIN return shape
    // ([:178-184 in system_prompt_v2.md). ltg_candidates may be absent
    // from the JSON entirely, not just empty — defaulting via (|| [])
    // covers both shapes.
    if ((v2.ltg_candidates || []).length === 0 && v2.clarifying_question) {
      const { data: planRow, error: planErr } = await db
        .from('goal_plans')
        .insert({
          client_id: String(client_id),
          user_id: user.id,
          framework_router: (v2.domain || []).join(',') || null,
          router_confidence: v2.domain_confidence != null
            ? String(v2.domain_confidence)
            : null,
          clarifying_answers: clarifying_answers || {},
          reasoning_trace: null,
          data_sources: [],
          status: 'awaiting_clarification',
        })
        .select()
        .single();

      if (planErr) {
        console.error('[generate-goals] clarifying plan insert failed:', planErr);
        return res.status(500).json({ error: 'plan insert failed' });
      }

      return res.status(200).json({
        plan_id: planRow.id,
        domain: v2.domain || [],
        domain_confidence: v2.domain_confidence,
        clarifying_question: v2.clarifying_question,
        child_name_used: v2.child_name_used || null,
        family_quote_held: v2.family_quote_held || null,
        goals: [],
        pending_attestation: false,
      });
    }

    // STANDARD HAPPY PATH — persist plan + LTGs (pending_attestation) +
    // STGs + one evidence tag per LTG. Loop is restructured into three
    // phases: insert all LTGs first to collect IDs, then insert STGs
    // grouped by ltg_index, then insert one goal_evidence_tags row per
    // LTG using framework_tag.
    const { data: planRow, error: planErr } = await db
      .from('goal_plans')
      .insert({
        client_id: String(client_id),
        user_id: user.id,
        status: 'draft',
        framework_router: (v2.domain || []).join(',') || null,
        router_confidence: v2.domain_confidence != null
          ? String(v2.domain_confidence)
          : null,
        clarifying_answers: clarifying_answers || {},
        reasoning_trace: null,
        data_sources: [],
      })
      .select()
      .single();

    if (planErr) throw new Error(`goal_plans insert failed: ${planErr.message}`);

    const planId = planRow.id;
    const ltgCandidates = v2.ltg_candidates || [];
    const stgCandidates = v2.stg_candidates || [];
    const priorityChips = v2.priority_chips || [];
    const primaryDomain = (v2.domain || [])[0] || null;

    // Phase 1 — insert all LTGs, collect into persistedLtgs[].
    const persistedLtgs = [];

    // Continue sequence_num from the client's current highest across
    // ALL statuses so regenerations don't collide with existing goals.
    const { data: ltgSeqRow, error: ltgSeqErr } = await db
      .from('long_term_goals')
      .select('sequence_num')
      .eq('client_id', String(client_id))
      .order('sequence_num', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ltgSeqErr) throw new Error(`LTG sequence_num lookup failed: ${ltgSeqErr.message}`);
    const ltgMaxSeq = ltgSeqRow?.sequence_num ?? 0;

    for (let i = 0; i < ltgCandidates.length; i++) {
      const ltg = ltgCandidates[i];
      const horizonMonths = ltg.horizon_months;
      const timeFrameWeeks = horizonMonths != null
        ? Math.round(horizonMonths * 4.33)
        : 12;

      const { data: ltgRow, error: ltgErr } = await db
        .from('long_term_goals')
        .insert({
          client_id: String(client_id),
          user_id: user.id,
          plan_id: planId,
          sequence_num: ltgMaxSeq + i + 1,
          category: null,
          domain: primaryDomain,
          framework: ltg.framework_tag ?? null,
          goal_text: ltg.text,
          notes: null,
          time_frame_weeks: timeFrameWeeks,
          is_ai_generated: true,
          original_text: ltg.text,
          evidence_rationale: null,
          status: 'pending_attestation',
          priority_chips_json: priorityChips,
          target_date: new Date(Date.now() + timeFrameWeeks * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        })
        .select()
        .single();

      if (ltgErr) throw new Error(`long_term_goals insert failed: ${ltgErr.message}`);
      persistedLtgs.push(ltgRow);
    }

    // Phase 2 — group STGs by ltg_index and insert per LTG.
    const stgsByLtgIndex = new Map();
    for (const stg of stgCandidates) {
      const idx = stg.ltg_index ?? 0;
      if (!stgsByLtgIndex.has(idx)) stgsByLtgIndex.set(idx, []);
      stgsByLtgIndex.get(idx).push(stg);
    }

    const persistedStgsByLtg = new Map();
    for (let i = 0; i < persistedLtgs.length; i++) {
      const ltgRow = persistedLtgs[i];
      const stgsForThisLtg = stgsByLtgIndex.get(i) || [];
      if (stgsForThisLtg.length === 0) {
        persistedStgsByLtg.set(ltgRow.id, []);
        continue;
      }

      // Identical pattern to LTGs above, scoped to this parent LTG.
      const { data: stgSeqRow, error: stgSeqErr } = await db
        .from('short_term_goals')
        .select('sequence_num')
        .eq('long_term_goal_id', ltgRow.id)
        .order('sequence_num', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (stgSeqErr) throw new Error(`STG sequence_num lookup failed: ${stgSeqErr.message}`);
      const stgMaxSeq = stgSeqRow?.sequence_num ?? 0;

      const stgRows = stgsForThisLtg.map((stg, j) => ({
        long_term_goal_id: ltgRow.id,
        client_id: String(client_id),
        user_id: user.id,
        sequence_num: stgMaxSeq + j + 1,
        specific: stg.text,
        measurable: '',
        mastery_criterion: { hint: stg.mastery_hint ?? '' },
        framework: stg.evidence_tag ?? null,
        domain: primaryDomain,
        target_accuracy: null,
        time_bound_sessions: null,
        is_ai_generated: true,
        original_text: stg.text,
        status: 'active',
      }));

      const { data: insertedStgs, error: stgErr } = await db
        .from('short_term_goals')
        .insert(stgRows)
        .select();

      if (stgErr) throw new Error(`short_term_goals insert failed: ${stgErr.message}`);
      persistedStgsByLtg.set(ltgRow.id, insertedStgs || []);
    }

    // Phase 3 — one evidence tag row per LTG via framework_tag. STG-level
    // evidence_tag lives on short_term_goals.framework directly above.
    const tagRows = persistedLtgs
      .map((ltgRow, i) => {
        const ftag = ltgCandidates[i]?.framework_tag;
        if (!ftag) return null;
        return {
          ltg_id: ltgRow.id,
          framework_name: ftag,
          rationale: null,
        };
      })
      .filter(Boolean);

    if (tagRows.length) {
      const { error: tagErr } = await db.from('goal_evidence_tags').insert(tagRows);
      if (tagErr) throw new Error(`goal_evidence_tags insert failed: ${tagErr.message}`);
    }

    const persistedGoals = persistedLtgs.map((ltgRow, i) => ({
      ...ltgRow,
      short_term_goals: persistedStgsByLtg.get(ltgRow.id) || [],
      evidence_tags: ltgCandidates[i]?.framework_tag
        ? [{ ltg_id: ltgRow.id, framework_name: ltgCandidates[i].framework_tag, rationale: null }]
        : [],
    }));

    return res.status(201).json({
      plan_id: planId,
      reasoning_trace: null,
      domain: v2.domain || [],
      domain_confidence: v2.domain_confidence,
      child_name_used: v2.child_name_used || null,
      family_quote_held: v2.family_quote_held || null,
      priority_chips: priorityChips,
      data_sources: [],
      router_confidence: v2.domain_confidence != null
        ? String(v2.domain_confidence)
        : null,
      goals: persistedGoals,
      pending_attestation: true,
      clarifying_question: null,
    });

  } catch (err) {
    console.error('[generate-goals] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/attest-goals', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = authHeader.split(' ')[1];

  const userClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { plan_id, rci_number } = req.body;
  if (!plan_id || !rci_number) {
    return res.status(400).json({ error: 'plan_id and rci_number required' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE);

  const [planRes, ltgRes] = await Promise.all([
    db.from('goal_plans').select('*').eq('id', plan_id).eq('user_id', user.id).single(),
    db.from('long_term_goals').select('*, short_term_goals(*), goal_evidence_tags(*)').eq('plan_id', plan_id)
  ]);

  if (planRes.error || !planRes.data) {
    return res.status(404).json({ error: 'Plan not found or not owned by this clinician' });
  }

  const snapshot = { plan: planRes.data, goals: ltgRes.data ?? [] };

  const { data: attestation, error: attestErr } = await db
    .from('goal_attestations')
    .insert({ plan_id, user_id: user.id, rci_number, plan_snapshot: snapshot })
    .select()
    .single();

  if (attestErr) {
    return res.status(500).json({ error: `Attestation failed: ${attestErr.message}` });
  }

  await db.from('goal_plans').update({ status: 'active' }).eq('id', plan_id);

  // Phase 4.0.7.23c-deploy — flip every pending_attestation LTG in this
  // plan to 'active' so v2 candidates become live clinical goals. No
  // attested_at/attested_by columns on long_term_goals (audit trail
  // lives in goal_attestations.plan_snapshot above). Failure is
  // non-fatal — plan-level attestation still recorded.
  const { error: ltgFlipErr } = await db
    .from('long_term_goals')
    .update({ status: 'active' })
    .eq('plan_id', plan_id)
    .eq('status', 'pending_attestation');

  if (ltgFlipErr) {
    console.error('[attest-goals] LTG status flip failed:', ltgFlipErr);
  }

  return res.status(201).json({
    attested: true,
    attestation_id: attestation.id,
    attested_at: attestation.attested_at
  });
});

module.exports = router;
