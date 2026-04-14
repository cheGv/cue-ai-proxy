const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
// FIX: Using process.env.PORT for Railway, defaulting to 3001 for local dev
const PORT = process.env.PORT || 3001;

// Initialize Anthropic (Railway will provide the API Key via environment variables)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Middleware
// The origin matches your Netlify URL
app.use(cors({ origin: 'https://trycueai.netlify.app' }));
app.use(express.json());

// Health Check Endpoint (For Step 3 of your plan)
app.get('/health', (req, res) => {
  res.json({ status: "ok", service: "cue-proxy" });
});

// Report Generation Endpoint
app.post('/generate-report', async (req, res) => {
  try {
    const { prompt } = req.body;
    const msg = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    res.json(msg);
  } catch (error) {
    console.error("Proxy Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});