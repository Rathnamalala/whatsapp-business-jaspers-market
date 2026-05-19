/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

module.exports = class Message {
  constructor(rawMessage) {
    this.id = rawMessage.id;
    this.senderPhoneNumber = rawMessage.from;
    this.rawType = rawMessage.type;

    if (rawMessage.type === 'interactive') {
      const interactiveType = rawMessage.interactive?.type;
      if (interactiveType === 'button_reply') {
        this.type = rawMessage.interactive.button_reply.id;
      } else if (interactiveType === 'list_reply') {
        this.type = rawMessage.interactive.list_reply.id;
      } else if (interactiveType === 'call_permission_reply') {
        this.type = 'call_permission_reply';
        this.callPermission = rawMessage.interactive.call_permission_reply;
      } else {
        this.type = 'interactive_other';
      }
    } else if (rawMessage.type === 'text') {
      this.type = 'text';
      this.text = rawMessage.text?.body;
    } else if (rawMessage.type === 'audio' || rawMessage.type === 'voice') {
      this.type = 'voice';
      this.mediaId = (rawMessage.audio || rawMessage.voice)?.id;
      this.mimeType = (rawMessage.audio || rawMessage.voice)?.mime_type;
    } else {
      this.type = rawMessage.type || 'unknown';
    }
  }
};
