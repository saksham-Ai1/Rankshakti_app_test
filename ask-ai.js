// netlify/functions/ask-ai.js
//
// This function is the ONLY place the real Gemini API key lives. It never
// reaches the browser, so nobody can steal it from "view source".
//
// It also enforces a daily per-student limit using Upstash Redis (a free,
// serverless Redis you access over plain HTTPS - no server to manage, fits
// Rankshakti's "no backend maintenance" vision) and logs basic usage stats
// (question count today, last-seen time) so you can see how the app is
// being used without ever collecting names, emails, or anything personal.
//
// ---- REQUIRED ENVIRONMENT VARIABLES (set these in Netlify dashboard →
//      Site settings → Environment variables — never put them in the code) ----
//   GEMINI_API_KEY            your key from https://aistudio.google.com/apikey
//   UPSTASH_REDIS_REST_URL    from your Upstash database's REST API tab
//   UPSTASH_REDIS_REST_TOKEN  from the same tab
//   DAILY_AI_LIMIT            optional, defaults to 40 (per student per day)

const GEMINI_MODEL = 'gemini-2.5-flash';

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // Redis not configured — fail open (no tracking, no limit)
  const res = await fetch(`${url}/${command.join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result;
}

function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

exports.handler = async function (event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Bad JSON' }) };
  }

  const { messages, clientId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'messages[] required' }) };
  }

  // ---- Rate limiting (anonymous, per-browser id the client generates once
  //      and stores in localStorage — no login, nothing personal) ----
  const limit = parseInt(process.env.DAILY_AI_LIMIT || '40', 10);
  const id = (clientId || 'anon').toString().slice(0, 80);
  const key = `ai:${todayKey()}:${id}`;

  try {
    const count = await redis(['incr', key]);
    if (count !== null) {
      await redis(['expire', key, '90000']); // ~25h, so it always outlives "today" in any timezone
      if (count > limit) {
        return {
          statusCode: 429,
          headers: cors,
          body: JSON.stringify({
            error: 'daily_limit_reached',
            message: 'Aaj ke liye AI ka daily limit khatam ho gaya. Kal phir try karein.',
          }),
        };
      }
    }
    // Lightweight, anonymous usage log — just a counter, nothing identifying.
    await redis(['incr', `stats:${todayKey()}:total_requests`]);
  } catch (e) {
    // If Redis is down/misconfigured, fail OPEN (student still gets an answer)
    // rather than blocking study — but this is logged so you notice in Netlify's
    // function logs.
    console.warn('Redis unavailable, proceeding without rate limit:', e.message);
  }

  // ---- Call Gemini ----
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server not configured (GEMINI_API_KEY missing)' }) };
  }

  try {
    const systemMsg = messages.find((m) => m.role === 'system');
    const turns = messages.filter((m) => m.role !== 'system');
    const payload = {
      contents: turns.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    };
    if (systemMsg) payload.system_instruction = { parts: [{ text: systemMsg.content }] };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({ error: `Gemini HTTP ${response.status}: ${errText.slice(0, 300)}` }),
      };
    }

    const data = await response.json();
    const text =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts.map((p) => p.text || '').join('').trim();

    if (!text) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Gemini returned empty response' }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ reply: text }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};
