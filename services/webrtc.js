"use strict";

const wrtc = require("@roamhq/wrtc");
const { RTCPeerConnection } = wrtc;
const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;

// Map of callId → { pc, audioSource, audioQueue, audioInterval, getAudioSink }
const activeCalls = new Map();

const SAMPLE_RATE = 48000;
const FRAME_SAMPLES = 480; // 10ms at 48kHz — matches OPUS native rate, no resampling needed
const SILENCE = new Int16Array(FRAME_SAMPLES); // reused zero-filled buffer

/**
 * Set up a WebRTC peer connection for an incoming call.
 *
 * Meta's stack is ICE-LITE so our ICE-FULL stack automatically assumes the
 * CONTROLLING role per RFC 5245 §2.7 — no special configuration needed.
 * We act as DTLS client (answerer side).
 *
 * A continuous 10ms audio interval starts immediately so the RTCAudioSource
 * keeps the audio track alive with silence between utterances. Speech frames
 * pushed via sendAudioToCall() are drained from audioQueue by this interval.
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

  // 1. setRemoteDescription FIRST — this auto-creates a transceiver for each m-line in the offer.
  //    Calling addTransceiver before this caused our sender track to be on an orphan transceiver
  //    that wasn't bound to the offer's audio m-line, so OPUS encoded silence into RTP.
  await pc.setRemoteDescription({ type: "offer", sdp: sdpOffer });

  // 2. Find the audio transceiver that the offer created and bind our outbound track to it.
  const audioTransceiver = pc.getTransceivers().find(
    (t) => t.receiver?.track?.kind === "audio"
  );
  if (!audioTransceiver) {
    throw new Error(`[webrtc] No audio m-line in SDP offer for ${callId}`);
  }
  const audioSource = new RTCAudioSource();
  const audioTrack = audioSource.createTrack();
  await audioTransceiver.sender.replaceTrack(audioTrack);
  audioTransceiver.direction = "sendrecv";
  console.log(`[webrtc] Bound audio track to offer's transceiver for ${callId}`);

  // 3. Attach sink to the inbound track from the same transceiver.
  let audioSink = null;
  if (onAudioChunk && audioTransceiver.receiver.track) {
    audioSink = new RTCAudioSink(audioTransceiver.receiver.track);
    audioSink.addEventListener("data", ({ samples, sampleRate, channelCount }) => {
      onAudioChunk(Buffer.from(samples.buffer), sampleRate, channelCount);
    });
  }

  // 4. Create and set the local answer.
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // 5. Wait for ICE gathering to complete.
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") resolve();
    });
    setTimeout(resolve, 5000);
  });

  // Continuous audio interval — sends silence when idle, speech frames when queued.
  // This keeps the RTCAudioSource track alive without gaps between utterances.
  const audioQueue = [];
  const audioInterval = setInterval(() => {
    if (!activeCalls.has(callId)) {
      clearInterval(audioInterval);
      return;
    }
    const chunk = audioQueue.length > 0 ? audioQueue.shift() : SILENCE;
    audioSource.onData({
      samples: chunk,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: FRAME_SAMPLES,
    });
  }, 10);

  activeCalls.set(callId, { pc, audioSource, audioQueue, audioInterval, getAudioSink: () => audioSink });

  return {
    sdpAnswer: pc.localDescription.sdp,
    audioSource,
  };
}

/**
 * Enqueue PCM audio for an active call. Frames are drained by the continuous
 * audio interval started in handleIncomingCall.
 * @param {string} callId
 * @param {Buffer} pcmBuffer - Signed 16-bit PCM samples at 48000 Hz mono
 * @param {number} sampleRate - Ignored; all audio is handled at SAMPLE_RATE (48000)
 * @param {number} channelCount - Must be 1
 */
function sendAudioToCall(callId, pcmBuffer, sampleRate = 48000, channelCount = 1) {
  const session = activeCalls.get(callId);
  if (!session) return;
  console.log(`[webrtc] Queuing ${Math.floor(pcmBuffer.length / 2)} samples (${(pcmBuffer.length / 2 / SAMPLE_RATE).toFixed(2)}s) for ${callId}`);

  const allSamples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.length / 2)
  );

  for (let i = 0; i < allSamples.length; i += FRAME_SAMPLES) {
    let chunk = allSamples.slice(i, i + FRAME_SAMPLES);
    if (chunk.length < FRAME_SAMPLES) {
      const padded = new Int16Array(FRAME_SAMPLES);
      padded.set(chunk);
      chunk = padded;
    }
    session.audioQueue.push(chunk);
  }
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
  activeCalls.delete(callId); // delete first so the interval self-stops
  try {
    clearInterval(session.audioInterval);
    const sink = session.getAudioSink();
    if (sink) sink.stop();
    session.pc.close();
  } catch (e) {
    // ignore errors on cleanup
  }
}

module.exports = { handleIncomingCall, sendAudioToCall, getPeerConnection, terminateCall };
