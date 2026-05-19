"use strict";

const wrtc = require("@roamhq/wrtc");
const { RTCPeerConnection } = wrtc;
const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;

// Map of callId → { pc, audioSink, audioSource }
const activeCalls = new Map();

/**
 * Set up a WebRTC peer connection for an incoming call.
 *
 * Meta's stack is ICE-LITE so our ICE-FULL stack automatically assumes the
 * CONTROLLING role per RFC 5245 §2.7 — no special configuration needed.
 * We act as DTLS client (answerer side).
 *
 * @param {string} callId
 * @param {string} sdpOffer - SDP offer string from WhatsApp Call Connect webhook
 * @param {function} onAudioChunk - Called with (Buffer samples, number sampleRate, number channels)
 * @returns {Promise<{ sdpAnswer: string, audioSource: RTCAudioSource }>}
 */
async function handleIncomingCall(callId, sdpOffer, onAudioChunk) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    sdpSemantics: "unified-plan",
  });

  const audioSource = new RTCAudioSource();
  const audioTrack = audioSource.createTrack();

  pc.addTransceiver(audioTrack, { direction: "sendrecv" });

  await pc.setRemoteDescription({ type: "offer", sdp: sdpOffer });

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // Wait for ICE gathering to complete
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") resolve();
    });
    // Safety timeout — proceed after 5s even if not complete
    setTimeout(resolve, 5000);
  });

  // Attach audio sink to the incoming track once remote track arrives
  let audioSink = null;
  pc.addEventListener("track", (event) => {
    if (event.track.kind === "audio" && onAudioChunk) {
      audioSink = new RTCAudioSink(event.track);
      audioSink.addEventListener("data", ({ samples, sampleRate, channelCount }) => {
        onAudioChunk(Buffer.from(samples.buffer), sampleRate, channelCount);
      });
    }
  });

  activeCalls.set(callId, { pc, audioSource, getAudioSink: () => audioSink });

  return {
    sdpAnswer: pc.localDescription.sdp,
    audioSource,
  };
}

/**
 * Send PCM audio to an active call.
 * @param {string} callId
 * @param {Buffer} pcmBuffer - Signed 16-bit PCM samples
 * @param {number} sampleRate - e.g. 44100
 * @param {number} channelCount - e.g. 1
 */
function sendAudioToCall(callId, pcmBuffer, sampleRate = 44100, channelCount = 1) {
  const session = activeCalls.get(callId);
  if (!session) return;

  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.length / 2
  );

  session.audioSource.onData({
    samples,
    sampleRate,
    bitsPerSample: 16,
    channelCount,
    numberOfFrames: samples.length / channelCount,
  });
}

/**
 * Returns the RTCPeerConnection for a call (for connection state monitoring).
 * @param {string} callId
 */
function getPeerConnection(callId) {
  return activeCalls.get(callId)?.pc ?? null;
}

/**
 * Close and clean up a call session.
 * @param {string} callId
 */
function terminateCall(callId) {
  const session = activeCalls.get(callId);
  if (!session) return;
  try {
    const sink = session.getAudioSink();
    if (sink) sink.stop();
    session.pc.close();
  } catch (e) {
    // ignore errors on cleanup
  }
  activeCalls.delete(callId);
}

module.exports = { handleIncomingCall, sendAudioToCall, getPeerConnection, terminateCall };
