/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

// Use dotenv to read .env vars into Node
require("dotenv").config();

// Required environment variables
const ENV_VARS = [
  "ACCESS_TOKEN",
  "APP_SECRET",
  "VERIFY_TOKEN",
  "REDIS_HOST",
  "REDIS_PORT"
];

module.exports = Object.freeze({
  // Application information
  appSecret: process.env.APP_SECRET,
  accessToken: process.env.ACCESS_TOKEN,
  verifyToken: process.env.VERIFY_TOKEN,

  // Server configuration
  port: process.env.PORT || 8080,
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: process.env.REDIS_PORT || 6379,

  // AI services
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
  businessContext: process.env.BUSINESS_CONTEXT || "",

  // Azure Cognitive Services TTS (optional — falls back to Deepgram if not set)
  azureSpeechKey:    process.env.AZURE_SPEECH_KEY    || "",
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION || "eastus",
  azureSpeechVoice:  process.env.AZURE_SPEECH_VOICE  || "en-US-AriaNeural",

  // Language override — forces Claude to respond only in this language, regardless of businessContext.md
  languageOverride: process.env.LANGUAGE_OVERRIDE || "",

  checkEnvVariables: function () {
    ENV_VARS.forEach(function (key) {
      if (!process.env[key]) {
        console.warn("WARNING: Missing the environment variable " + key);
      }
    });
  }
});
