// const logger = require("../../utils/logger");
// const ApiError = require("../../utils/ApiError");

// const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
// const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// /**
//  * Calls Gemini's generateContent endpoint and returns the model's raw text.
//  * Uses native fetch (Node 18+) — no SDK dependency needed.
//  *
//  * @param {Object} opts
//  * @param {string} opts.apiKey
//  * @param {string} opts.systemInstruction
//  * @param {Array<{role: 'user'|'model', text: string}>} opts.history
//  * @param {Object} [opts.responseSchema] - if provided, forces JSON output matching this schema
//  * @param {number} [opts.temperature]
//  */
// async function generateContent({
//   apiKey,
//   systemInstruction,
//   history,
//   responseSchema,
//   temperature = 0.8,
// }) {
//   if (!apiKey) {
//     throw ApiError.badRequest(
//       "No Gemini API key configured — add one in Settings before enabling AI conversations",
//     );
//   }

//   const url = `${API_BASE}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

//   const body = {
//     system_instruction: { parts: [{ text: systemInstruction }] },
//     contents: history.map((turn) => ({
//       role: turn.role,
//       parts: [{ text: turn.text }],
//     })),

//     generationConfig: {
//       temperature,
//       maxOutputTokens: 1024,
//       ...(responseSchema
//         ? { responseMimeType: "application/json", responseSchema }
//         : {}),
//     },

//     generationConfig: {
//       temperature,
//       maxOutputTokens: 1024,
//       ...(responseSchema
//         ? {
//             responseMimeType: "application/json",
//             responseJsonSchema: responseSchema,
//           }
//         : {}),
//     },
//     // generationConfig: {
//     //   temperature,
//     //   maxOutputTokens: 1024,
//     //   ...(responseSchema
//     //     ? { responseMimeType: 'application/json', responseSchema }
//     //     : {}),
//     // },
//   };

//   let response;
//   try {
//     response = await fetch(url, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify(body),
//     });
//   } catch (err) {
//     logger.error("[gemini] Network error calling Gemini API", {
//       error: err.message,
//     });
//     throw ApiError.internal("Failed to reach Gemini API");
//   }

//   if (!response.ok) {
//     const errText = await response.text().catch(() => "");
//     logger.error("[gemini] Gemini API returned an error", {
//       status: response.status,
//       body: errText,
//     });
//     throw ApiError.internal(`Gemini API error (${response.status})`);
//   }

//   const data = await response.json();
//   const text =
//     data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

//   if (!text) {
//     const blockReason = data?.promptFeedback?.blockReason;
//     logger.warn("[gemini] Empty response from Gemini", { blockReason });
//   }

//   return { text, raw: data };
// }

// /** Convenience wrapper: calls generateContent with a JSON schema and parses the result. */
// async function generateStructured({
//   apiKey,
//   systemInstruction,
//   history,
//   responseSchema,
//   temperature,
// }) {
//   const { text, raw } = await generateContent({
//     apiKey,
//     systemInstruction,
//     history,
//     responseSchema,
//     temperature,
//   });

//   try {
//     return { parsed: JSON.parse(text), raw };
//   } catch (err) {
//     logger.error("[gemini] Failed to parse structured JSON response", {
//       text: text.slice(0, 500),
//     });
//     throw ApiError.internal("AI returned an unparseable response");
//   }
// }

// module.exports = { generateContent, generateStructured, DEFAULT_MODEL };

const logger = require("../../utils/logger");
const ApiError = require("../../utils/ApiError");

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Keep AI replies reasonably short for faster generation.
// Can be overridden from environment if needed.
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 512);

// Safety timeout. This does NOT intentionally delay the request.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 15000);

/**
 * Calls Gemini's generateContent endpoint and returns the model's raw text.
 *
 * Flow remains:
 * conversationEngine
 *      ↓
 * generateStructured
 *      ↓
 * generateContent
 *      ↓
 * Gemini
 *      ↓
 * JSON response
 *
 * Uses native fetch (Node 18+) — no SDK dependency needed.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.systemInstruction
 * @param {Array<{role: 'user'|'model', text: string}>} opts.history
 * @param {Object} [opts.responseSchema]
 * @param {number} [opts.temperature]
 */
async function generateContent({
  apiKey,
  systemInstruction,
  history = [],
  responseSchema,
  temperature = 0.8,
}) {
  if (!apiKey) {
    throw ApiError.badRequest(
      "No Gemini API key configured — add one in Settings before enabling AI conversations",
    );
  }

  const url = `${API_BASE}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

  /*
   * Keep only valid conversation turns.
   *
   * This does NOT change the conversation flow.
   * It simply prevents empty/invalid history items from
   * being sent to Gemini.
   */
  const contents = Array.isArray(history)
    ? history
        .filter(
          (turn) =>
            turn &&
            (turn.role === "user" || turn.role === "model") &&
            typeof turn.text === "string" &&
            turn.text.trim().length > 0,
        )
        .map((turn) => ({
          role: turn.role,
          parts: [{ text: turn.text }],
        }))
    : [];

  const body = {
    system_instruction: {
      parts: [{ text: systemInstruction || "" }],
    },

    contents,

    /*
     * IMPORTANT:
     * Keep only ONE generationConfig.
     *
     * 512 tokens is enough for our structured WhatsApp response
     * in the current flow and reduces unnecessary generation.
     */
    generationConfig: {
      temperature,
      maxOutputTokens: MAX_OUTPUT_TOKENS,

      ...(responseSchema
        ? {
            responseMimeType: "application/json",
            responseJsonSchema: responseSchema,
          }
        : {}),
    },
  };

  const startedAt = Date.now();

  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),

      /*
       * Prevent a stuck Gemini request from hanging indefinitely.
       * This is a maximum timeout, NOT an artificial delay.
       */
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (err) {
    const duration = Date.now() - startedAt;

    logger.error("[gemini] Request failed", {
      duration: `${duration}ms`,
      error: err.message,
      model: DEFAULT_MODEL,
    });

    if (err.name === "TimeoutError") {
      throw ApiError.internal("Gemini request timed out");
    }

    logger.error("[gemini] Network error calling Gemini API", {
      error: err.message,
    });

    throw ApiError.internal("Failed to reach Gemini API");
  }

  const duration = Date.now() - startedAt;

  logger.info("[gemini] API response received", {
    duration: `${duration}ms`,
    status: response.status,
    model: DEFAULT_MODEL,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");

    logger.error("[gemini] Gemini API returned an error", {
      duration: `${duration}ms`,
      status: response.status,
      body: errText,
      model: DEFAULT_MODEL,
    });

    throw ApiError.internal(`Gemini API error (${response.status})`);
  }

  let data;

  try {
    data = await response.json();
  } catch (err) {
    logger.error("[gemini] Failed to parse Gemini response JSON", {
      duration: `${Date.now() - startedAt}ms`,
      error: err.message,
    });

    throw ApiError.internal("Invalid response received from Gemini");
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("") || "";

  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;

    logger.warn("[gemini] Empty response from Gemini", {
      duration: `${Date.now() - startedAt}ms`,
      blockReason,
      finishReason: data?.candidates?.[0]?.finishReason,
    });
  }

  logger.info("[gemini] Generation completed", {
    duration: `${Date.now() - startedAt}ms`,
    outputLength: text.length,
    model: DEFAULT_MODEL,
  });

  return {
    text,
    raw: data,
  };
}

/**
 * Convenience wrapper:
 * Calls generateContent with a JSON schema and parses the result.
 *
 * Existing conversationEngine flow remains unchanged.
 */
async function generateStructured({
  apiKey,
  systemInstruction,
  history,
  responseSchema,
  temperature,
}) {
  const { text, raw } = await generateContent({
    apiKey,
    systemInstruction,
    history,
    responseSchema,
    temperature,
  });

  try {
    return {
      parsed: JSON.parse(text),
      raw,
    };
  } catch (err) {
    logger.error("[gemini] Failed to parse structured JSON response", {
      text: text.slice(0, 500),
    });

    throw ApiError.internal("AI returned an unparseable response");
  }
}

module.exports = {
  generateContent,
  generateStructured,
  DEFAULT_MODEL,
};
