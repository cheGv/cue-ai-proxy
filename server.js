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
    const { clientName, session, additionalContext } = req.body;

    const prompt = `You are an expert Speech-Language Pathologist. Generate a professional session note for the following:

Client: ${clientName}
Session Date: ${session?.date || 'Not specified'}
Goal: ${session?.goal || 'Not specified'}
Activity: ${session?.activity || 'Not specified'}
Trials: ${session?.totalTrials || 0} attempts, ${session?.independentTrials || 0} independent, ${session?.promptedTrials || 0} prompted
Goal Met: ${session?.goalMet ? 'Yes' : 'No'}
Affect/Regulation: ${session?.affect || 'Not specified'}
Notes: ${session?.notes || 'None'}
${additionalContext ? 'Additional Context: ' + additionalContext : ''}

Write a concise, professional session note suitable for a clinical record.`;

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

app.listen(PORT, () => {
  console.log(`Cue proxy listening on port ${PORT}`);
});
