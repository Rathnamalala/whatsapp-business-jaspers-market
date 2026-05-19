"use strict";

const config = require("./config");

const ELEVENLABS_MODEL = "eleven_turbo_v2_5";

module.exports = class Voice {
  /**
   * Transcribe audio buffer using Deepgram REST API.
   * @param {Buffer} audioBuffer - Raw audio bytes
   * @param {string} mimeType - e.g. 'audio/ogg; codecs=opus'
   * @returns {Promise<string>} Transcript text
   */
  static async transcribeAudio(audioBuffer, mimeType) {
    const contentType = mimeType ? mimeType.split(";")[0].trim() : "audio/ogg";
    const response = await fetch(
      "https://api.deepgram.com/v1/listen?smart_format=true&model=nova-3",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${config.deepgramApiKey}`,
          "Content-Type": contentType,
        },
        body: audioBuffer,
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Deepgram transcription failed: ${err}`);
    }

    const data = await response.json();
    const transcript =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    return transcript;
  }

  /**
   * Synthesize speech — uses Azure TTS if AZURE_SPEECH_KEY is set, else Deepgram Aura.
   * Returns raw PCM at 48000 Hz, 16-bit, mono (matches OPUS native rate — no resampling needed).
   * @param {string} text
   * @returns {Promise<Buffer>} PCM audio buffer (signed 16-bit, 48000 Hz, mono)
   */
  static async synthesizeSpeech(text) {
    if (config.azureSpeechKey) {
      return Voice.synthesizeSpeechAzure(text);
    }
    const response = await fetch(
      "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=48000",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${config.deepgramApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Deepgram TTS failed: ${err}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Synthesize speech using Azure Cognitive Services TTS.
   * Output format: raw-24khz-16bit-mono-pcm (no header, ready for RTCAudioSource).
   * @param {string} text
   * @returns {Promise<Buffer>} PCM audio buffer (signed 16-bit, 24000 Hz, mono)
   */
  static async synthesizeSpeechAzure(text) {
    const { azureSpeechKey: key, azureSpeechRegion: region, azureSpeechVoice: voice } = config;
    const lang = voice.split('-').slice(0, 2).join('-'); // e.g. "si-LK" from "si-LK-ThiliniNeural"
    const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${voice}'>${text}</voice></speak>`;
    const response = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "raw-48khz-16bit-mono-pcm",
        },
        body: ssml,
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Azure TTS failed: ${err}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Synthesize speech as MP3 (for WhatsApp voice note upload).
   * @param {string} text
   * @returns {Promise<Buffer>} MP3 buffer
   */
  static async synthesizeSpeechMp3(text) {
    const voiceId = config.elevenLabsVoiceId;
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": config.elevenLabsApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: ELEVENLABS_MODEL,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`ElevenLabs TTS (mp3) failed: ${err}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
};
