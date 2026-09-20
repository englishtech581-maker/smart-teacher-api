// Calls the real public Anthropic API using a server-held key.
// This is different from the sandboxed fetch used inside Claude.ai's own
// artifact preview — a deployed app needs its own API key and pays standard
// API rates. Get a key at https://console.anthropic.com

async function callClaude({ system, user, maxTokens = 1000 }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw { status: 500, message: "Server is missing ANTHROPIC_API_KEY" };
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw { status: 502, message: `AI request failed: ${errText.slice(0, 200)}` };
  }
  const data = await response.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
  return text.replace(/```json|```/g, "").trim();
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw { status: 502, message: "AI returned a response we couldn't parse" };
  }
}

module.exports = { callClaude, parseJSON };
