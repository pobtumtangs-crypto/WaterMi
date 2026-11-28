// Last-resort photo analysis through Groq, used only when no Gemini model can answer (busy or at its limit).

const URL = 'https://api.groq.com/openai/v1/chat/completions';
// Groq counts tokens per minute (8,000 on the account this was tested with), so replies are capped.
const MAX_REPLY_TOKENS = 3000;

// The report schema is written in Gemini's style. Groq's strict mode needs standard JSON Schema,
// with every property required and no others allowed.
export function toJsonSchema(node) {
  const out = { type: node.type.toLowerCase() };
  if (node.enum) out.enum = node.enum;
  if (node.items) out.items = toJsonSchema(node.items);
  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([name, child]) => [name, toJsonSchema(child)]),
    );
    out.required = Object.keys(node.properties);
    out.additionalProperties = false;
  }
  return out;
}

export class GroqError extends Error {
  constructor(status) {
    super(`Groq request failed (${status || 'no response'})`);
    this.status = status;
  }
}

// Returns the reply text ('' if there is none). Throws GroqError if Groq cannot be used.
export async function groqAnalysis({ fetch, key, model }, { system, context, image, schema }, signal) {
  let res;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        ...(/qwen/i.test(model) && { reasoning_effort: 'none' }),
        max_completion_tokens: MAX_REPLY_TOKENS,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'plant_report', strict: true, schema: toJsonSchema(schema) },
        },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: context },
              { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
            ],
          },
        ],
      }),
      signal,
    });
  } catch {
    // The error text is not passed on, so a request detail can never reach the log.
    throw new GroqError(0);
  }
  if (!res.ok) throw new GroqError(res.status);
  const body = await res.json().catch(() => null);
  return body?.choices?.[0]?.message?.content ?? '';
}
