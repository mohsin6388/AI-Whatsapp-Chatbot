const logger = require('../../utils/logger');
const ApiError = require('../../utils/ApiError');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Calls Gemini's generateContent endpoint and returns the model's raw text.
 * Uses native fetch (Node 18+) — no SDK dependency needed.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.systemInstruction
 * @param {Array<{role: 'user'|'model', text: string}>} opts.history
 * @param {Object} [opts.responseSchema] - if provided, forces JSON output matching this schema
 * @param {number} [opts.temperature]
 */
async function generateContent({ apiKey, systemInstruction, history, responseSchema, temperature = 0.8 }) {
  if (!apiKey) {
    throw ApiError.badRequest(
      'No Gemini API key configured — add one in Settings before enabling AI conversations'
    );
  }

  const url = `${API_BASE}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: history.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    })),
    generationConfig: {
      temperature,
      maxOutputTokens: 1024,
      ...(responseSchema
        ? { responseMimeType: 'application/json', responseSchema }
        : {}),
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.error('[gemini] Network error calling Gemini API', { error: err.message });
    throw ApiError.internal('Failed to reach Gemini API');
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[gemini] Gemini API returned an error', { status: response.status, body: errText });
    throw ApiError.internal(`Gemini API error (${response.status})`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    logger.warn('[gemini] Empty response from Gemini', { blockReason });
  }

  return { text, raw: data };
}

/** Convenience wrapper: calls generateContent with a JSON schema and parses the result. */
async function generateStructured({ apiKey, systemInstruction, history, responseSchema, temperature }) {
  const { text, raw } = await generateContent({
    apiKey,
    systemInstruction,
    history,
    responseSchema,
    temperature,
  });

  try {
    return { parsed: JSON.parse(text), raw };
  } catch (err) {
    logger.error('[gemini] Failed to parse structured JSON response', { text: text.slice(0, 500) });
    throw ApiError.internal('AI returned an unparseable response');
  }
}

module.exports = { generateContent, generateStructured, DEFAULT_MODEL };
