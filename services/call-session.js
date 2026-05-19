"use strict";

const { DeepgramClient } = require("@deepgram/sdk");
const WebRTC = require("./webrtc");
const AI = require("./ai");
const Voice = require("./voice");
const GraphApi = require("./graph-api");
const config = require("./config");

// Map of callId → { dgConnection, sdpAnswer, isProcessing, accepted }
const activeSessions = new Map();

const ENDPOINTING_MS = 800;

/**
 * Start a live AI call session.
 *
 * Ordering:
 *   1. Open Deepgram streaming WebSocket → waitForOpen()
 *   2. Create WebRTC peer connection → SDP answer + ICE
 *   3. POST pre_accept with SDP answer
 *   4. WebRTC 'connected' → POST accept → send AI greeting
 *   5. Audio loop: RTCAudioSink → Deepgram → Claude → Deepgram TTS PCM → RTCAudioSource
 */
async function startCallSession(callId, sdpOffer, senderPhoneNumberId, callerNumber) {
  console.log(`[call-session] Starting call ${callId} from ${callerNumber}`);

  const session = { dgConnection: null, sdpAnswer: null, isProcessing: false, accepted: false };
  activeSessions.set(callId, session);

  // ── 1. Deepgram streaming STT ──────────────────────────────────────────────
  const dgClient = new DeepgramClient({ apiKey: config.deepgramApiKey });

  const dgConnection = await dgClient.listen.v1.connect({
    model: "nova-2",
    encoding: "linear16",
    sample_rate: 48000,
    channels: 1,
    language: "en",
    smart_format: true,
    interim_results: true,
    endpointing: ENDPOINTING_MS,
  });

  dgConnection.on("open", () => {
    console.log(`[call-session] Deepgram open for call ${callId}`);
  });

  dgConnection.on("message", async (data) => {
    if (data.type !== "Results") return;
    const transcript = data?.channel?.alternatives?.[0]?.transcript ?? "";
    if (!data?.is_final || !data?.speech_final || !transcript) return;

    const s = activeSessions.get(callId);
    if (!s || s.isProcessing) return;

    s.isProcessing = true;
    console.log(`[call-session] Transcript: "${transcript}"`);

    try {
      const responseText = await AI.generateTextResponse(transcript);
      console.log(`[call-session] AI response: "${responseText}"`);
      const pcmBuffer = await Voice.synthesizeSpeech(responseText);
      WebRTC.sendAudioToCall(callId, pcmBuffer, 24000, 1);
    } catch (err) {
      console.error(`[call-session] AI/TTS error:`, err.message);
    } finally {
      const s2 = activeSessions.get(callId);
      if (s2) s2.isProcessing = false;
    }
  });

  dgConnection.on("error", (err) => {
    console.error(`[call-session] Deepgram error for call ${callId}:`, err.message);
  });

  dgConnection.connect();
  await dgConnection.waitForOpen();

  session.dgConnection = dgConnection;

  // ── 2. WebRTC peer connection ──────────────────────────────────────────────
  const { sdpAnswer } = await WebRTC.handleIncomingCall(
    callId,
    sdpOffer,
    (pcmBuf) => {
      try {
        dgConnection.socket?.send(pcmBuf);
      } catch (_) {}
    }
  );

  session.sdpAnswer = sdpAnswer;

  // ── 3. Pre-accept ──────────────────────────────────────────────────────────
  try {
    await GraphApi.callAction(senderPhoneNumberId, callId, "pre_accept", sdpAnswer);
    console.log(`[call-session] pre_accept sent for call ${callId}`);
  } catch (err) {
    console.error(`[call-session] pre_accept failed:`, err.message);
  }

  // ── 4. Monitor WebRTC → accept + greeting once connected ──────────────────
  const pc = WebRTC.getPeerConnection(callId);
  if (pc) {
    pc.addEventListener("connectionstatechange", async () => {
      console.log(`[call-session] WebRTC state: ${pc.connectionState} for call ${callId}`);

      if (pc.connectionState === "connected") {
        const s = activeSessions.get(callId);
        if (s && !s.accepted) {
          s.accepted = true;
          try {
            await GraphApi.callAction(senderPhoneNumberId, callId, "accept", sdpAnswer);
            console.log(`[call-session] accept sent for call ${callId}`);
            sendGreeting(callId).catch(console.error);
          } catch (err) {
            console.error(`[call-session] accept failed:`, err.message);
          }
        }
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        await endCallSession(callId);
      }
    });
  }
}

async function sendGreeting(callId) {
  const session = activeSessions.get(callId);
  if (!session || session.isProcessing) return;
  session.isProcessing = true;
  try {
    const greeting = await AI.generateCallGreeting();
    console.log(`[call-session] Greeting: "${greeting}"`);
    const pcmBuffer = await Voice.synthesizeSpeech(greeting);
    WebRTC.sendAudioToCall(callId, pcmBuffer, 24000, 1);
  } catch (err) {
    console.error(`[call-session] Greeting error:`, err.message);
  } finally {
    const s = activeSessions.get(callId);
    if (s) s.isProcessing = false;
  }
}

/**
 * End and clean up a call session.
 */
async function endCallSession(callId) {
  console.log(`[call-session] Ending call ${callId}`);
  const session = activeSessions.get(callId);
  if (!session) return;

  try {
    const dg = session.dgConnection;
    if (dg) {
      dg.socket?.send(JSON.stringify({ type: "CloseStream" }));
      dg.socket?.close();
    }
  } catch (_) {}

  WebRTC.terminateCall(callId);
  activeSessions.delete(callId);
}

module.exports = { startCallSession, endCallSession };
