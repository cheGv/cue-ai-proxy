const express = require('express');
const fetch = require('node-fetch');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = 3001;

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS — allow localhost origins and production Netlify app
const ALLOWED_ORIGINS = [
  'https://trycueai.netlify.app',
];

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    ALLOWED_ORIGINS.includes(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/generate-report', async (req, res) => {
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
  }
});

app.listen(PORT, () => {
  console.log(`Cue proxy listening on http://localhost:${PORT}`);
});
