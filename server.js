const express = require('express');
const fetch = require('node-fetch');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = [
    'https://trycueai.netlify.app',
    'https://chegv.github.io',
    'http://localhost:3000',
    'http://localhost:8080',
  ];
  if (allowed.includes(origin) || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'cue-proxy' }));

app.post('/generate-report', async (req, res) => {
  try {
    const { clientName, session, additionalContext, goals } = req.body;

    const name       = clientName || 'Client';
    const date       = session?.date         || 'Not specified';
    const goal       = session?.goal         || 'Not specified';
    const activity   = session?.activity     || 'Not specified';
    const attempts   = session?.totalTrials       || 0;
    const independent = session?.independentTrials || 0;
    const prompted   = session?.promptedTrials    || 0;
    const goalMet    = session?.goalMet      || 'Not specified';

    const totalTrials  = parseInt(attempts)   || 0;
    const indepTrials  = parseInt(independent) || 0;
    const promptTrials = parseInt(prompted)   || 0;
    const indepPct     = totalTrials > 0 ? Math.round((indepTrials  / totalTrials) * 100) : 0;
    const promptPct    = totalTrials > 0 ? Math.round((promptTrials / totalTrials) * 100) : 0;
    const affect     = session?.affect       || 'Not specified';
    const notes      = session?.notes        || 'None';
    const goalsText = goals && goals.length > 0
  ? `\n\nACTIVE THERAPY GOALS:\n${goals.map(g => 
      `- [${g.domain}] ${g.goal} (target: ${g.target})`
    ).join('\n')}`
  : '';

     const prompt = `You are Cue, a clinical AI assistant for RCI-certified Speech-Language Pathologists in India. Generate a professional two-page clinical report from the session data below.

═══════════════════════════════════════════
SECTION 1 — DOCUMENTATION INTEGRITY (NON-NEGOTIABLE)
═══════════════════════════════════════════
1. You did NOT observe this session. You have only the structured data provided.
2. NEVER fabricate, invent, or imagine specific utterances, quotes, or examples of what the client said. Example of what is FORBIDDEN: writing "Arjun said 'the boy is running because he wants the ball'" when no such quote was in the data.
3. NEVER generate hypothetical sentence examples attributed to the client. Do not write "he produced sentences like X" unless X was explicitly provided.
4. Describe performance ONLY in clinical abstractions supported by the data — e.g. "produced complex sentences with conjunctions on 6 of 10 trials" — NOT a fabricated example of such a sentence.
5. If specific utterance data is absent, write "Specific utterance data not recorded this session" rather than inventing examples to enrich the narrative.

═══════════════════════════════════════════
SECTION 2 — LINGUISTIC FIDELITY
═══════════════════════════════════════════
1. Preserve native language terms, transliterations, or code-switching (English-Telugu, English-Kannada, English-Hindi, etc.) EXACTLY as provided. Do not "correct", translate, or anglicize non-English clinical targets, utterances, or activity names.
2. LINGUISTIC NEUTRALITY: Do not apply English grammatical rules to observations of utterances in other languages. Evaluate phonological or syntactic performance strictly per the rules of the target language as provided.
3. If the session mentions a target language (e.g. "target language: Kannada"), frame all clinical interpretation within that language's structure, not English.

═══════════════════════════════════════════
SECTION 3 — STRUCTURE, TONE & PARENT SUMMARY
═══════════════════════════════════════════
1. CLINICAL REPORT (Page 1): Neutral, third-person professional tone. No direct quotes fabricated. Trial data and goal performance are the primary evidence.
2. PARENT SUMMARY (Page 2): Warm, jargon-free, strengths-based. You MAY use generic teaching examples (e.g. "using long sentences to connect ideas with 'because'") to help parents understand what was worked on, but you must NOT attribute specific words or quotes to the child that were not in the data.
3. LENGTH: Aim for a professional two-page structure. If session data is sparse, do NOT "fluff" the narrative to fill space. Produce a high-quality concise report instead, and append a "Clinical Note" at the end of Page 1 identifying specific data gaps (e.g. "Utterance-level data not captured; recommend narration for next session").
4. Use neurodiversity-affirming, strengths-based language throughout. Never pathologize..

CLIENT: ${name}
DATE: ${date}
GOAL: ${goal}
ACTIVITY: ${activity}
TOTAL TRIALS: ${attempts}
INDEPENDENT RESPONSES: ${independent}
PROMPTED RESPONSES: ${prompted}
GOAL MET: ${goalMet}
AFFECT/REGULATION: ${affect}
NEXT SESSION FOCUS: ${notes}${goalsText}

Generate the report in this exact format with these exact headers. Use plain text only — no asterisks, no hashtags, no markdown.

PAGE 1 — CLINICAL SESSION NOTE

Client Name: ${name}
Date of Service: ${date}
Service Type: Individual Speech-Language Therapy
Clinician: RCI-Certified Speech-Language Pathologist

SUBJECTIVE:
[Client's presentation, affect, regulation, and behavioral observations during the session. Include any caregiver-reported information if available.]

OBJECTIVE:
Target Goal: ${goal}
Activity: ${activity}
Trial Data:
- Total Trials: ${totalTrials}
- Independent Responses: ${indepTrials} (${indepPct}%)
- Prompted Responses: ${promptTrials} (${promptPct}%)
- Goal Met: ${goalMet}
Client Affect/Regulation: ${affect}

ASSESSMENT:
[Clinical interpretation of performance. Comment on skill acquisition, generalization potential, impact of regulation on learning, and progress toward goals.]

PLAN:
[Next session targets, therapy modifications, strategies to support regulation, frequency recommendations.]

Next Session Focus: ${notes}

---

PAGE 2 — PARENT COMMUNICATION SUMMARY

Dear Parent/Caregiver,

Here is a summary of today's session for ${name}:

WHAT WE WORKED ON TODAY:
[Explain the goal and activity in simple, jargon-free language a non-clinician parent can understand.]

HOW ${name.toUpperCase()} DID TODAY:
[Strengths-based, positive description of the child's performance. Mention specific achievements. Frame challenges constructively.]

TRY THIS AT HOME:
1. [Practical home activity related to today's goal — specific and doable in 5 minutes]
2. [Second home activity — playful and easy to implement]
3. [Third suggestion — can be incorporated into daily routine]

COMING UP NEXT SESSION:
[Brief, encouraging preview of what will be worked on next. Keep it positive and forward-looking.]

Remember: Every session builds on the last. Your involvement at home makes a significant difference in your child's progress.

---
Generated by Cue AI | RCI-Certified SLP Documentation`;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      }),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
  }
});

app.post('/narrate-session', async (req, res) => {
  try {
    const { transcript, clientName } = req.body;
    const today = new Date().toISOString().split('T')[0];

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: 'You are Cue, a clinical AI for RCI-certified SLPs in India. Extract structured session data from a clinician\'s verbal narration and respond ONLY with valid JSON — no markdown, no code fences, no preamble, no explanation.',
        messages: [{
          role: 'user',
          content: `Extract session data from this narration and return a single JSON object with EXACTLY these keys:
- date (string, YYYY-MM-DD format; today is ${today} — use today if the narration does not mention a date)
- target_behaviour (string)
- activity_name (string)
- attempts (integer)
- independent_responses (integer)
- prompted_responses (integer)
- goal_met (string: "yes" or "not_yet")
- client_affect (string: exactly one of "Regulated", "Dysregulated", or "Mixed")
- next_session_focus (string)

Client name: ${clientName || 'Not specified'}
Narration: ${transcript}

Respond with the JSON object only. No other text.`
        }],
      }),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Narrate error:', err);
    res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
  }
});

app.listen(PORT, () => {
  console.log(`Cue proxy listening on port ${PORT}`);
});
