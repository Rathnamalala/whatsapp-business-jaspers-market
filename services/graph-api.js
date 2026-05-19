/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

const { FacebookAdsApi } = require('facebook-nodejs-business-sdk');
const config = require("./config");

const api = new FacebookAdsApi(config.accessToken);

module.exports = class GraphApi {
  static async #makeApiCall(messageId, senderPhoneNumberId, requestBody) {
    try {
      // Mark as read and send typing indicator
      if (messageId) {
        const typingBody = {
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          "typing_indicator": {
            "type": "text"
          }
        };

        await api.call(
          'POST',
          [`${senderPhoneNumberId}`, 'messages'],
          typingBody
        );
      }


      const response = await api.call(
        'POST',
        [`${senderPhoneNumberId}`, 'messages'],
        requestBody
      );
      console.log('API call successful:', response);
      return response;
    } catch (error) {
      console.error('Error making API call:', error);
      throw error;
    }
  }

  static async messageWithInteractiveReply(messageId, senderPhoneNumberId, recipientPhoneNumber, messageText, replyCTAs) {
    const requestBody = {
      messaging_product: "whatsapp",
      to: recipientPhoneNumber,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: messageText
        },
        action: {
          buttons: replyCTAs.map(cta => ({
            type: "reply",
            reply: {
              id: cta.id,
              title: cta.title
            }
          }))
        }
      }
    };

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  static async messageWithUtilityTemplate(messageId, senderPhoneNumberId, recipientPhoneNumber, options) {
    const { templateName, locale, imageLink } = options;
    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhoneNumber,
      type: "template",
      template: {
        "name": templateName,
        "language": {
          "code": locale
        },
        "components": [
          {
            "type": "header",
            "parameters": [
              {
                "type": "image",
                "image": {
                  "link": imageLink
                }
              }
            ]
          },
        ]
      }
    };

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  static async messageWithLimitedTimeOfferTemplate(messageId, senderPhoneNumberId, recipientPhoneNumber, options) {

    const { templateName, locale, imageLink, offerCode } = options;

    const currentTime = new Date();
    const futureTime = new Date(currentTime.getTime() + (48 * 60 * 60 * 1000));

    const requestBody = {
      "messaging_product": "whatsapp",
      "recipient_type": "individual",
      "to": recipientPhoneNumber,
      "type": "template",
      "template": {
        "name": templateName,
        "language": {
          "code": locale
        },
        "components": [
          {
            "type": "header",
            "parameters": [
              {
                "type": "image",
                "image": {
                  "link": imageLink
                }
              }
            ]
          },
          {
            "type": "limited_time_offer",
            "parameters": [
              {
                "type": "limited_time_offer",
                "limited_time_offer": {
                  "expiration_time_ms": futureTime.getTime()
                }
              }
            ]
          },
          {
            "type": "button",
            "sub_type": "copy_code",
            "index": 0,
            "parameters": [
              {
                "type": "coupon_code",
                "coupon_code": offerCode
              }
            ]
          }
        ]
      }
    };

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  /**
   * Send a plain text message.
   */
  static async sendTextMessage(messageId, senderPhoneNumberId, recipientPhoneNumber, text) {
    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhoneNumber,
      type: "text",
      text: { body: text },
    };
    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  /**
   * Send an audio message using an already-uploaded WhatsApp media ID.
   */
  static async sendAudioMessage(messageId, senderPhoneNumberId, recipientPhoneNumber, mediaId) {
    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhoneNumber,
      type: "audio",
      audio: { id: mediaId },
    };
    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  /**
   * Get metadata (URL, mime_type) for a WhatsApp media object.
   * @param {string} mediaId
   */
  static async getMediaInfo(mediaId) {
    return api.call("GET", [mediaId], {});
  }

  /**
   * Download WhatsApp media from its signed URL.
   * @param {string} mediaUrl
   * @returns {Promise<Buffer>}
   */
  static async downloadMedia(mediaUrl) {
    const response = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Media download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Upload audio to WhatsApp media store.
   * @param {string} senderPhoneNumberId
   * @param {Buffer} audioBuffer
   * @param {string} mimeType - e.g. 'audio/mpeg' or 'audio/wav'
   * @returns {Promise<string>} The uploaded media ID
   */
  static async uploadMedia(senderPhoneNumberId, audioBuffer, mimeType) {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBuffer], { type: mimeType }),
      mimeType === "audio/mpeg" ? "audio.mp3" : "audio.wav"
    );
    formData.append("type", mimeType);
    formData.append("messaging_product", "whatsapp");

    const response = await fetch(
      `https://graph.facebook.com/v22.0/${senderPhoneNumberId}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.accessToken}` },
        body: formData,
      }
    );
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Media upload failed: ${err}`);
    }
    const data = await response.json();
    return data.id;
  }

  /**
   * Perform a call action (pre_accept, accept, reject, terminate) on the Calls API.
   * @param {string} senderPhoneNumberId
   * @param {string} callId
   * @param {string} action - 'pre_accept' | 'accept' | 'reject' | 'terminate'
   * @param {string|null} sdpAnswer - Required for pre_accept and accept
   */
  static async callAction(senderPhoneNumberId, callId, action, sdpAnswer = null) {
    const body = {
      messaging_product: "whatsapp",
      call_id: callId,
      action,
    };
    if (sdpAnswer) {
      body.session = { sdp_type: "answer", sdp: sdpAnswer };
    }
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${senderPhoneNumberId}/calls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Call action '${action}' failed: ${err}`);
    }
    return response.json();
  }

  static async messageWithMediaCardCarousel(messageId, senderPhoneNumberId, recipientPhoneNumber, options) {
    const { templateName, locale, imageLinks } = options;
    const requestBody = {
      "messaging_product": "whatsapp",
      "recipient_type": "individual",
      "to": recipientPhoneNumber,
      "type": "template",
      "template": {
        "name": templateName,
        "language": {
          "code": locale
        },
        "components": [
          {
            "type": "carousel",
            "cards": imageLinks.map((imageLink, idx) => ({
              "card_index": idx,
              "components": [
                {
                  "type": "header",
                  "parameters": [
                    {
                      "type": "image",
                      "image": {
                        "link": imageLink
                      }
                    }
                  ]
                }
              ]
            }))
          }
        ]
      }
    };

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

};
