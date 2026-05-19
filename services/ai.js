"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const client = new Anthropic({ apiKey: config.anthropicApiKey });

function loadSystemPrompt() {
  const contextFile = path.join(__dirname, "../businessContext.md");
  if (fs.existsSync(contextFile)) {
    return fs.readFileSync(contextFile, "utf8").trim();
  }
  if (config.businessContext) {
    return config.businessContext;
  }
  return (
    "You are a helpful WhatsApp business assistant. " +
    "Reply concisely and naturally, as a human agent would. " +
    "Keep responses short and conversational — suitable for a chat interface. " +
    "For calls, speak naturally as if on a phone call: no bullet points or markdown."
  );
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
