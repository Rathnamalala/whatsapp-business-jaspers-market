"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const client = new Anthropic({ apiKey: config.anthropicApiKey });

function loadSystemPrompt() {
  const contextFile = path.join(__dirname, "../businessContext.md");
  let base;
  if (fs.existsSync(contextFile)) {
    base = fs.readFileSync(contextFile, "utf8").trim();
  } else if (config.businessContext) {
    base = config.businessContext;
  } else {
    base = (
      "You are a helpful WhatsApp business assistant. " +
      "Reply concisely and naturally, as a human agent would. " +
      "Keep responses short and conversational — suitable for a chat interface. " +
      "For calls, speak naturally as if on a phone call: no bullet points or markdown."
    );
  }
  if (config.languageOverride) {
    base += `\n\n## LANGUAGE OVERRIDE\nIMPORTANT: Always respond ONLY in ${config.languageOverride}. Do not use any other language regardless of what other instructions say.`;
  }
  return base;
}

const SYSTEM_PROMPT = loadSystemPrompt();

module.exports = class AI {
  static async generateTextResponse(userMessage) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    return response.content[0].text;
  }

  /**
   * Generate a short response for a live phone call — kept terse to minimize TTS latency.
   */
  static async generateCallResponse(userMessage) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      system:
        SYSTEM_PROMPT +
        "\n\n## CALL RESPONSE STYLE\n" +
        "You are on a LIVE phone call. Respond in ONE short sentence (max 15 words). " +
        "Speak naturally, no markdown, no bullet points, no lists. " +
        "Get straight to the point — the caller is waiting and long replies feel laggy.",
      messages: [{ role: "user", content: userMessage }],
    });
    return response.content[0].text;
  }

  static async generateCallGreeting() {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            "A customer just called. Give a short, warm greeting to open the call. " +
            "One or two sentences maximum. Natural spoken language only.",
        },
      ],
    });
    return response.content[0].text;
  }
};
