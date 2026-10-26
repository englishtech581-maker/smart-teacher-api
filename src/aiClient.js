// Talks to whichever AI provider is configured on the server.
//
//   AI_PROVIDER      "claude" or "gemini". If not set, Claude is used when ANTHROPIC_API_KEY exists, otherwise Gemini.
//   ANTHROPIC_API_KEY, AI_MODEL     (default model: claude-haiku-5-5, the cheapest)
//   GEMINI_API_KEY,   GEMINI_MODEL  (default: gemini-flash-latest, with gemini-2.5-flash as a backup)
//
// Keys stay on the server. The website never sees them.

const ANTHROPIC_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const GEMINI_URL = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";

function pickProvider() {
  const want = (process.env.AI_PROVIDER || "").toLowerCase();
  if (want === "claude" && process.env.ANTHROPIC_API_KEY) return "claude";
  if (want === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return null;
}

async function viaClaude({ system, user, maxTokens }) {
  const response = await fetch(`${ANTHROPIC_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "claude-haiku-5-5",
      max_tokens: Math.max(maxTokens, 1500),
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    if (/credit balance/i.test(body)) {
      throw { status: 503, message: "The AI account has no credit left. Ask the school administrator to add credit or switch the AI option." };
    }
    if (response.status === 429) throw { status: 429, message: "The AI is busy right now. Please try again in a minute." };
    console.error("Claude error", response.status, body.slice(0, 300));
    throw { status: 502, message: "The AI could not answer right now." };
  }
  const data = await response.json();
  return (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

async function viaGemini({ system, user, maxTokens }) {
  const models = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-flash-latest", "gemini-2.5-flash"];
  for (const model of models) {
    const response = await fetch(`${GEMINI_URL}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        // Room is left for the model's own thinking, which counts against this limit.
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 4096), responseMimeType: "application/json" },
      }),
    });
    if (response.status === 404 && models.indexOf(model) < models.length - 1) continue; // model name retired, try the next
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) throw { status: 429, message: "The free AI limit has been reached for now. Please try again later." };
      if (response.status === 400 && /API key/i.test(body)) throw { status: 503, message: "The Gemini key on the server is not valid." };
      if (response.status === 404) throw { status: 503, message: "The Gemini model name is out of date. Set GEMINI_MODEL on the server." };
      console.error("Gemini error", response.status, body.slice(0, 300));
      throw { status: 502, message: "The AI could not answer right now." };
    }
    const data = await response.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    return parts.map((p) => p.text || "").join("\n");
  }
  throw { status: 503, message: "No Gemini model is available." };
}

async function callClaude({ system, user, maxTokens = 1000 }) {
  const provider = pickProvider();
  if (!provider) throw { status: 503, message: "AI is not set up on the server yet. Add ANTHROPIC_API_KEY or GEMINI_API_KEY." };
  const text = provider === "claude" ? await viaClaude({ system, user, maxTokens }) : await viaGemini({ system, user, maxTokens });
  return text.replace(/```json|```/g, "").trim();
}

// The AI is asked for JSON only, but if it adds a stray sentence we still keep the JSON part.
function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fall through */ }
    }
    throw { status: 502, message: "The AI answer could not be read. Please try again." };
  }
}

module.exports = { callClaude, callAI: callClaude, parseJSON, pickProvider };
