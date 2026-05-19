"use strict";

const WebSocket = require("ws");
const WebRTC = require("./webrtc");
const GraphApi = require("./graph-api");
const config = require("./config");
const fs = require("fs");
const path = require("path");

// Map of callId → { ws, sdpAnswer, accepted }
const activeSessions = new Map();

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
    "Keep responses short and conversational — suitable for a phone call. " +
    "No bullet points or markdown. Speak naturally."
  );
}

/**
 * Start a live AI call session using Deepgram Voice Agent.
 *
 * Ordering:
 *   1. Open Deepgram Voice Agent WebSocket
 *   2. Create WebRTC peer connection → SDP answer + ICE
 *   3. POST pre_accept with SDP answer
 *   4. WebRTC 'connected' → POST accept → send InjectAgentMessage to trigger greeting
 *   5. Audio loop: RTCAudioSink → Voice Agent WS → TTS audio → RTCAudioSource
 */
async function startCallSession(callId, sdpOffer, senderPhoneNumberId, callerNumber) {
  console.log(`[call-session] Starting call ${callId} from ${callerNumber}`);

  const session = { ws: null, sdpAnswer: null, accepted: false };
  activeSessions.set(callId, session);

  const systemPrompt = loadSystemPrompt();

  // ── 1. Deepgram Voice Agent WebSocket ─────────────────────────────────────
  const ws = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", {
    headers: { Authorization: `Token ${config.deepgramApiKey}` },
  });
  ws.binaryType = "nodebuffer";
  session.ws = ws;

  ws.on("open", () => {
    console.log(`[call-session] Voice Agent open for call ${callId}`);
  });

  ws.on("message", (data) => {
    if (Buffer.isBuffer(data)) {
      // TTS audio output → send to caller
      WebRTC.sendAudioToCall(callId, data, 24000, 1);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[call-session] Voice Agent msg:`, JSON.stringify(msg));

      if (msg.type === "Welcome") {
        // Server ready — send configuration
        ws.send(JSON.stringify({
          type: "SettingsConfiguration",
          audio: {
            input:  { encoding: "linear16", sample_rate: 48000 },
            output: { encoding: "linear16", sample_rate: 24000, container: "none" },
          },
          agent: {
            listen: { model: "nova-2" },
            think: {
              provider: {
                type: "anthropic",
                api_key: config.anthropicApiKey,
              },
              model: "claude-3-5-sonnet-20241022",
              instructions: systemPrompt,
            },
            speak: { model: "aura-2-thalia-en" },
          },
        }));
      } else if (msg.type === "ConversationText") {
        console.log(`[call-session] ${msg.role === "user" ? "Transcript" : "Agent"}: "${msg.content}"`);
      }
    } catch (_) {}
  });

  ws.on("error", (err) => {
    console.error(`[call-session] Voice Agent WS error for call ${callId}:`, err.message);
  });

  ws.on("close", () => {
    console.log(`[call-session] Voice Agent closed for call ${callId}`);
    endCallSession(callId).catch(() => {});
  });

  // ── 2. WebRTC peer connection ──────────────────────────────────────────────
  const { sdpAnswer } = await WebRTC.handleIncomingCall(
    callId,
    sdpOffer,
    (pcmBuf) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(pcmBuf); } catch (_) {}
      }
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

  // ── 4. Monitor WebRTC → accept + trigger greeting once connected ───────────
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
            // Trigger opening greeting via Voice Agent
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "InjectAgentMessage",
                message: "A customer just called. Greet them warmly in one sentence.",
              }));
            }
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

/**
 * End and clean up a call session.
 */
async function endCallSession(callId) {
  const session = activeSessions.get(callId);
  if (!session) return;
  activeSessions.delete(callId);

  console.log(`[call-session] Ending call ${callId}`);

  try {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "CloseStream" }));
      session.ws.close();
    }
  } catch (_) {}

  WebRTC.terminateCall(callId);
}

module.exports = { startCallSession, endCallSession };
