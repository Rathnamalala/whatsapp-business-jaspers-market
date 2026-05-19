/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

const constants = require("./constants");
const config = require("./config");
const GraphApi = require("./graph-api");
const Message = require("./message");
const Status = require("./status");
const Cache = require("./redis");
const AI = require("./ai");
const Voice = require("./voice");
const CallSession = require("./call-session");


// ─── Existing demo reply helpers (unchanged) ──────────────────────────────────

function sendTryOutDemoMessage(messageId, senderPhoneNumberId, recipientPhoneNumber, messageBody) {
  return GraphApi.messageWithInteractiveReply(
    messageId,
    senderPhoneNumberId,
    recipientPhoneNumber,
    messageBody,
    [
      { id: constants.REPLY_INTERACTIVE_MEDIA_ID, title: constants.REPLY_INTERACTIVE_WITH_MEDIA_CTA },
      { id: constants.REPLY_MEDIA_CAROUSEL_ID, title: constants.REPLY_MEDIA_CARD_CAROUSEL_CTA },
      { id: constants.REPLY_OFFER_ID, title: constants.REPLY_OFFER_CTA },
    ]
  );
}

function sendInteractiveMediaMessage(messageId, senderPhoneNumberId, recipientPhoneNumber) {
  return GraphApi.messageWithUtilityTemplate(
    messageId, senderPhoneNumberId, recipientPhoneNumber,
    {
      templateName: "grocery_delivery_utility",
      locale: "en_US",
      imageLink: "https://scontent.xx.fbcdn.net/mci_ab/uap/asset_manager/id/?ab_b=e&ab_page=AssetManagerID&ab_entry=1530053877871776",
    }
  );
}

function sendLimitedTimeOfferMessage(messageId, senderPhoneNumberId, recipientPhoneNumber) {
  return GraphApi.messageWithLimitedTimeOfferTemplate(
    messageId, senderPhoneNumberId, recipientPhoneNumber,
    {
      templateName: "strawberries_limited_offer",
      locale: "en_US",
      imageLink: "https://scontent.xx.fbcdn.net/mci_ab/uap/asset_manager/id/?ab_b=e&ab_page=AssetManagerID&ab_entry=1393969325614091",
      offerCode: "BERRIES20",
    }
  );
}

function sendMediaCarouselMessage(messageId, senderPhoneNumberId, recipientPhoneNumber) {
  return GraphApi.messageWithMediaCardCarousel(
    messageId, senderPhoneNumberId, recipientPhoneNumber,
    {
      templateName: "recipe_media_carousel",
      locale: "en_US",
      imageLinks: [
        "https://scontent.xx.fbcdn.net/mci_ab/uap/asset_manager/id/?ab_b=e&ab_page=AssetManagerID&ab_entry=1389202275965231",
        "https://scontent.xx.fbcdn.net/mci_ab/uap/asset_manager/id/?ab_b=e&ab_page=AssetManagerID&ab_entry=3255815791260974",
      ],
    }
  );
}

async function markMessageForFollowUp(messageId) {
  await Cache.insert(messageId);
}


// ─── AI-powered voice note handler ────────────────────────────────────────────

async function handleVoiceMessage(message, senderPhoneNumberId) {
  if (!message.mediaId) {
    console.warn("[conversation] Voice message has no media ID, skipping");
    return;
  }

  try {
    // 1. Fetch download URL from WhatsApp
    const mediaInfo = await GraphApi.getMediaInfo(message.mediaId);
    const audioBuffer = await GraphApi.downloadMedia(mediaInfo.url);

    // 2. Transcribe
    const transcript = await Voice.transcribeAudio(audioBuffer, message.mimeType);
    if (!transcript) {
      await GraphApi.sendTextMessage(
        message.id, senderPhoneNumberId, message.senderPhoneNumber,
        "Sorry, I couldn't understand that audio. Could you try again or type your message?"
      );
      return;
    }

    console.log(`[conversation] Voice transcript: "${transcript}"`);

    // 3. Claude response
    const responseText = await AI.generateTextResponse(transcript);

    // 4. ElevenLabs → MP3 for WhatsApp voice note
    const mp3Buffer = await Voice.synthesizeSpeechMp3(responseText);

    // 5. Upload to WhatsApp
    const uploadedMediaId = await GraphApi.uploadMedia(
      senderPhoneNumberId, mp3Buffer, "audio/mpeg"
    );

    // 6. Send audio reply
    await GraphApi.sendAudioMessage(
      message.id, senderPhoneNumberId, message.senderPhoneNumber, uploadedMediaId
    );
  } catch (err) {
    console.error("[conversation] Voice message pipeline error:", err);
    // Fallback to text so the user always gets a response
    try {
      await GraphApi.sendTextMessage(
        message.id, senderPhoneNumberId, message.senderPhoneNumber,
        "Sorry, I had trouble processing your voice message. Please try again."
      );
    } catch (e) { /* ignore */ }
  }
}


// ─── Conversation class ───────────────────────────────────────────────────────

module.exports = class Conversation {
  constructor(phoneNumberId) {
    this.phoneNumberId = phoneNumberId;
  }

  static async handleMessage(senderPhoneNumberId, rawMessage) {
    const message = new Message(rawMessage);

    switch (message.type) {
      // ── Existing demo button-reply flows (untouched) ──────────────────────
      case constants.REPLY_INTERACTIVE_MEDIA_ID: {
        const res = await sendInteractiveMediaMessage(
          message.id, senderPhoneNumberId, message.senderPhoneNumber
        );
        await markMessageForFollowUp(res.messages[0].id);
        break;
      }
      case constants.REPLY_MEDIA_CAROUSEL_ID: {
        const res = await sendMediaCarouselMessage(
          message.id, senderPhoneNumberId, message.senderPhoneNumber
        );
        await markMessageForFollowUp(res.messages[0].id);
        break;
      }
      case constants.REPLY_OFFER_ID: {
        const res = await sendLimitedTimeOfferMessage(
          message.id, senderPhoneNumberId, message.senderPhoneNumber
        );
        await markMessageForFollowUp(res.messages[0].id);
        break;
      }

      // ── AI text response ──────────────────────────────────────────────────
      case "text": {
        try {
          const reply = await AI.generateTextResponse(message.text || "");
          await GraphApi.sendTextMessage(
            message.id, senderPhoneNumberId, message.senderPhoneNumber, reply
          );
        } catch (err) {
          console.error("[conversation] Text AI error:", err);
        }
        break;
      }

      // ── AI voice note pipeline ────────────────────────────────────────────
      case "voice": {
        await handleVoiceMessage(message, senderPhoneNumberId);
        break;
      }

      // ── Call permission reply — log and acknowledge, no further action ────
      case "call_permission_reply": {
        const perm = message.callPermission;
        console.log(
          `[conversation] Call permission reply from ${message.senderPhoneNumber}: ` +
          `response=${perm?.response}, permanent=${perm?.is_permanent}, ` +
          `source=${perm?.response_source}`
        );
        break;
      }

      // ── Unknown / other interactive types — Claude fallback ──────────────
      default: {
        try {
          const reply = await AI.generateTextResponse(
            "Hello, I received your message but couldn't understand the type. How can I help you?"
          );
          await GraphApi.sendTextMessage(
            message.id, senderPhoneNumberId, message.senderPhoneNumber, reply
          );
        } catch (err) {
          console.error("[conversation] Default AI error:", err);
        }
        break;
      }
    }
  }

  /**
   * Handle incoming call events from value.calls[].
   * event === 'connect' → start live AI call session
   * event === 'terminate' → clean up session
   */
  static async handleCall(senderPhoneNumberId, callEvent) {
    const { id: callId, event, from: callerNumber, session } = callEvent;

    if (event === "connect") {
      const sdpOffer = session?.sdp;
      if (!sdpOffer) {
        console.warn(`[conversation] Call ${callId} has no SDP offer, skipping`);
        return;
      }
      CallSession.startCallSession(
        callId, sdpOffer, senderPhoneNumberId, callerNumber
      ).catch((err) => {
        console.error(`[conversation] Failed to start call session ${callId}:`, err);
      });
    } else if (event === "terminate") {
      CallSession.endCallSession(callId).catch(console.error);
    } else {
      console.log(`[conversation] Unhandled call event: ${event} for call ${callId}`);
    }
  }

  static async handleStatus(senderPhoneNumberId, rawStatus) {
    const status = new Status(rawStatus);

    if (!(status.status === "delivered" || status.status === "read")) {
      return;
    }

    if (await Cache.remove(status.messageId)) {
      await sendTryOutDemoMessage(
        undefined,
        senderPhoneNumberId,
        status.recipientPhoneNumber,
        constants.APP_TRY_ANOTHER_MESSAGE
      );
    }
  }
};
