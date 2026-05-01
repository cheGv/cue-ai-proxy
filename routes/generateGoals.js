const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are Cue's clinical reasoning layer, co-authoring a treatment goal plan for a speech-language pathologist. You are an assistant, not a decision-maker. The clinician reviews and attests every plan you produce.

YOUR CLINICAL CASCADE — think in this order, always:

Step 1 — Regulatory substrate: What is this child's regulatory signature? Look for sensory processing patterns (seeking/avoiding/mixed), interoceptive awareness markers (Kelly Mahler), co-regulation capacity, dysregulation triggers, Polyvagal state indicators. If regulation is significantly compromised, LTG 1 must address regulatory co-occurrence with communication — not communication in isolation.

Step 2 — Communicative intent profile: Which functions are present (request, protest, comment, share, greet, direct attention, reject)? Which are absent or emerging? Is intent spontaneous or only responsive to adult scaffolding?

Step 3 — Language processing pathway: Gestalt (NLA/Blanc) or analytic? If GLP, which NLA stage? If analytic, what morphosyntactic level and productive vocabulary size?

Step 4 — Modality and motor planning: Primary expressive modality? If AAC: symbolic level, vocabulary size, access method, modelling exposure. If verbal: motor speech indicators — linguistic vs phonological vs motor planning barrier (PROMPT framework).

Step 5 — Goal prioritisation: (1) Regulatory dysregulation primary → LTG 1 = regulation + communication co-occurrence. (2) Intent emerging, regulation adequate → LTG 1 = intent expansion. (3) Intent present, form limiting → LTG 1 = modality/motor planning. AAC always gets its own LTG if it is the primary modality.

NEURODIVERSITY-AFFIRMING CONSTRAINTS — hard rules, any violation is a critical failure:
NEVER include: "reduce stimming", "increase eye contact", "decrease non-compliance", "reduce echolalic language", "normalise", "respond correctly", "appropriate behaviour".
ALWAYS frame goals as expansion of repertoire, adding modality not replacing, increasing access not reducing expression.

LANGUAGE DISCIPLINE — see CLAUDE.md §13. Cue presumes competence; goals describe what the child WILL DO, not what is missing or wrong. FORBIDDEN words and phrases when describing children, goals, or families: stuck, overdue, behind, no progress, plateau, struggling, failing, regressing, slow learner, low-functioning, non-progressing, falling behind, lagging, despite, intervention timing, developmental trajectory, critical window, critical period, missed opportunity, falling further, gap widening, behind peers, age-appropriate, age-typical. The phrase "developmental delay" is forbidden as a Cue-authored verdict; quoting the diagnosis field verbatim is fine.

GOAL STATEMENT STRUCTURE — see CLAUDE.md §13.3 — non-negotiable. Every long-term goal renders in two parts:

  PART A — Goal statement: a single parseable sentence, 25–35 words, leading with the clinical action and ending with the measurement frame. Format:
    "[Subject] will [action] [conditions] [criterion] [time/sessions frame]."

  Correct example (action-first, scannable):
    "The child will request objects, activities, or regulatory breaks using a clinician-selected AAC system across two communicative partners, at 80% independence over 3 consecutive sessions, within 12 weeks."

  FORBIDDEN example (84 words, leads with timing, buries the action inside nested clauses):
    "Within 12 weeks, during structured therapy sessions and at least one generalisation context (home or classroom), the child will use a clinician-selected AAC system (symbol level and access method to be determined following feature matching assessment) to independently communicate a request for an object, activity, or regulatory break across a minimum of 2 communicative partners, with 80% independence across 3 consecutive data collection sessions, given consistent co-regulation scaffolding from a familiar adult."

  PART B — Conditions block: a separate paragraph following the goal statement, plain sentences (NOT parenthetical clauses inside the goal statement). Lists setting requirements, scaffolding dependencies, and TBD assessment notes.
    Example:
      "Conditions: structured therapy + at least one generalisation context (home/classroom). AAC symbol level and access method TBD via feature matching assessment. Co-regulation scaffolding from a familiar adult is provided throughout."

Apply the same Part A / Part B structure to short-term steps where they are substantial enough to need it. Short-term steps under ~25 words: render as a single sentence with no conditions block.

OUTPUT FIELD CONTRACT for goals:
  goal_text          → Part A only. 25–35 words. Action-first, ends with criterion + time frame. No nested parentheticals, no leading "Within N weeks…". MUST be a single sentence.
  conditions_text    → Part B only. The conditions paragraph. Empty string if no conditions are needed.
  short_term_goals[].specific      → Part A for the step.
  short_term_goals[].conditions_text → Part B for the step (empty string when the step is under ~25 words).

INSUFFICIENT DATA PROTOCOL: If fewer than 3 clinical sessions AND no formal assessment, set router_confidence to "low", framework_router to "generic_fallback", populate data_gaps, produce maximum 1 LTG.

OUTPUT: Return ONLY valid JSON — no preamble, no markdown fences, no text outside the JSON object.

{
  "framework_router": "regulatory_asd or generic_fallback",
  "router_confidence": "high or low",
  "data_sources": ["brief description of each source"],
  "reasoning_trace": "single prose paragraph 150-220 words, third person, clinical register, no bullets",
  "data_gaps": null,
  "goals": [
    {
      "sequence_num": 1,
      "category": "regulatory_communicative | language_development | aac_modality | motor_speech | pragmatics",
      "domain": "short clinical domain label",
      "title": "one sentence active voice what child WILL DO",
      "goal_text": "PART A only — 25-35 words, action-first, ends with criterion + time frame. No leading 'Within N weeks…'.",
      "conditions_text": "PART B — conditions paragraph (settings, scaffolding, TBD notes). Empty string if not needed.",
      "time_frame_weeks": 12,
      "evidence_rationale": "2-3 sentences citing specific sessions or assessments",
      "evidence_tags": [
        {"framework_name": "framework name", "rationale": "one sentence why this applies"}
      ],
      "short_term_goals": [
        {"sequence_num": 1, "specific": "Part A for the step", "conditions_text": "Part B (empty string if short)", "measurable": "criterion", "target_accuracy": 80, "time_bound_sessions": 8},
        {"sequence_num": 2, "specific": "...", "conditions_text": "...", "measurable": "...", "target_accuracy": 80, "time_bound_sessions": 10},
        {"sequence_num": 3, "specific": "...", "conditions_text": "...", "measurable": "...", "target_accuracy": 80, "time_bound_sessions": 12}
      ]
    }
  ]
}

Rules: 2-3 LTGs, exactly 3 STOs each, STOs sequence scaffold to criterion to generalisation.`;

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

  const { client_id, clarifying_answers } = req.body;
  if (!client_id || !clarifying_answers) {
    return res.status(400).json({ error: 'client_id and clarifying_answers are required' });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE);

  try {
    const [clientRes, sessionsRes, goalsRes] = await Promise.all([
      db.from('clients').select('*').eq('id', client_id).single(),
      db.from('clinical_sessions')
        .select('id, session_date, soap_note, session_summary, goals_addressed')
        .eq('client_id', client_id)
        .order('session_date', { ascending: false })
        .limit(10),
      db.from('goals')
        .select('goal_text, domain, status')
        .eq('client_id', client_id)
        .eq('status', 'active')
    ]);

    if (clientRes.error) throw new Error(`Client fetch failed: ${clientRes.error.message}`);

    const client = clientRes.data;
    const sessions = sessionsRes.data || [];
    const existingGoals = goalsRes.data || [];

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

    const chartPayload = {
      client: {
        age_years: ageYears,
        age_months: ageMonths,
        diagnosis: client.diagnosis ?? null,
        languages: client.languages?.length ? client.languages : client.primary_language ? [client.primary_language] : [],
        aac_status: client.aac_status ?? (client.uses_aac ? 'emerging' : 'none'),
        communication_modality: client.communication_modality ?? null
      },
      clarifying_answers,
      session_notes: sessions.map(s => {
        const date = s.session_date ? `(${s.session_date})` : '';
        return [s.soap_note, s.session_summary, s.goals_addressed].filter(Boolean).join(' ').trim() || `Session ${date}: No notes recorded`;
      }),
      assessments: existingGoals.length ? [`Existing active goals: ${existingGoals.map(g => g.goal_text).join('; ')}`] : [],
      intake_notes: client.additional_notes ?? null,
      clinician_hypothesis: req.body.clinician_hypothesis ?? null
    };

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
        messages: [{ role: 'user', content: JSON.stringify(chartPayload) }]
      })
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${errBody.slice(0, 200)}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text ?? '';

    let plan;
    try {
      const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      plan = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ error: 'Claude returned malformed JSON', raw_preview: rawText.slice(0, 300) });
    }

    const { data: planRow, error: planErr } = await db
      .from('goal_plans')
      .insert({
        client_id: String(client_id),
        user_id: user.id,
        status: 'draft',
        framework_router: plan.framework_router,
        router_confidence: plan.router_confidence,
        clarifying_answers,
        reasoning_trace: plan.reasoning_trace,
        data_sources: plan.data_sources ?? []
      })
      .select()
      .single();

    if (planErr) throw new Error(`goal_plans insert failed: ${planErr.message}`);

    const planId = planRow.id;
    const insertedGoals = [];

    for (const goal of (plan.goals ?? [])) {
      const { data: ltgRow, error: ltgErr } = await db
        .from('long_term_goals')
        .insert({
          client_id: String(client_id),
          user_id: user.id,
          plan_id: planId,
          sequence_num: goal.sequence_num,
          category: goal.category,
          domain: goal.domain,
          goal_text: goal.goal_text,
          // Phase 3.3: conditions paragraph stored alongside the goal
          // statement. Persisted into `notes` (existing column on
          // long_term_goals) prefixed with the previous title so neither
          // signal is lost. The chart screen can split on the prefix
          // when it eventually renders Part B as its own paragraph.
          notes: (goal.conditions_text != null && goal.conditions_text.trim() !== '')
              ? `${goal.title}\n\nConditions: ${goal.conditions_text}`
              : goal.title,
          time_frame_weeks: goal.time_frame_weeks ?? 12,
          is_ai_generated: true,
          original_text: goal.goal_text,
          evidence_rationale: goal.evidence_rationale,
          status: 'active',
          target_date: new Date(Date.now() + (goal.time_frame_weeks ?? 12) * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        })
        .select()
        .single();

      if (ltgErr) throw new Error(`long_term_goals insert failed: ${ltgErr.message}`);

      const stoRows = (goal.short_term_goals ?? []).map(sto => {
        // Phase 3.3 — STO conditions get appended to the original_text
        // field so they round-trip without a schema migration. The
        // primary `specific` field carries Part A only.
        const conditions = (sto.conditions_text ?? '').trim();
        const original = conditions
          ? `${sto.specific}\n\nConditions: ${conditions}`
          : sto.specific;
        return {
          long_term_goal_id: ltgRow.id,
          client_id: String(client_id),
          user_id: user.id,
          sequence_num: sto.sequence_num,
          specific: sto.specific,
          measurable: sto.measurable,
          target_accuracy: sto.target_accuracy ?? 80,
          time_bound_sessions: sto.time_bound_sessions ?? 12,
          is_ai_generated: true,
          original_text: original,
          status: 'active'
        };
      });

      if (stoRows.length) {
        const { error: stoErr } = await db.from('short_term_goals').insert(stoRows);
        if (stoErr) throw new Error(`short_term_goals insert failed: ${stoErr.message}`);
      }

      const tagRows = (goal.evidence_tags ?? []).map(tag => ({
        ltg_id: ltgRow.id,
        framework_name: tag.framework_name,
        rationale: tag.rationale
      }));

      if (tagRows.length) {
        const { error: tagErr } = await db.from('goal_evidence_tags').insert(tagRows);
        if (tagErr) throw new Error(`goal_evidence_tags insert failed: ${tagErr.message}`);
      }

      insertedGoals.push({ ...ltgRow, short_term_goals: stoRows, evidence_tags: tagRows });
    }

    return res.status(201).json({
      plan_id: planId,
      framework_router: plan.framework_router,
      router_confidence: plan.router_confidence,
      reasoning_trace: plan.reasoning_trace,
      data_sources: plan.data_sources,
      data_gaps: plan.data_gaps ?? null,
      goals: insertedGoals
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

  return res.status(201).json({
    attested: true,
    attestation_id: attestation.id,
    attested_at: attestation.attested_at
  });
});

module.exports = router;
