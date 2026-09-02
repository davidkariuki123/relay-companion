// Generated from packages/shared/src/chat-presentation.ts. Do not edit directly.
"use strict";
var RelayChatPresentation = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../shared/src/chat-presentation.ts
  var chat_presentation_exports = {};
  __export(chat_presentation_exports, {
    chatMessageAuthorPresentation: () => chatMessageAuthorPresentation,
    idleChatLiveFollowState: () => idleChatLiveFollowState,
    isActiveOwnedAgentMessage: () => isActiveOwnedAgentMessage,
    isOwnedAgentMessage: () => isOwnedAgentMessage,
    ownedAgentProvider: () => ownedAgentProvider,
    reduceChatLiveFollow: () => reduceChatLiveFollow,
    shouldPinChatLiveFollow: () => shouldPinChatLiveFollow
  });
  function normalizedDirection(direction) {
    return direction === "out" || direction === "outbound" ? "outbound" : "inbound";
  }
  function normalizedName(value) {
    return String(value || "").trim();
  }
  function providerFromSurface(surfaceValue) {
    const surface = normalizedName(surfaceValue).toLowerCase();
    if (surface === "codex") return "codex";
    if (surface === "claude" || surface === "claude_code") return "claude";
    return void 0;
  }
  function isOwnedAgentMessage(message) {
    return message.ownedAgent === true || message.source?.host === "relay-agent-run";
  }
  function ownedAgentProvider(message) {
    return isOwnedAgentMessage(message) ? providerFromSurface(message.source?.surface) : void 0;
  }
  function chatMessageAuthorPresentation(message) {
    const direction = normalizedDirection(message.direction);
    const outbound = direction === "outbound";
    const ownedAgent = isOwnedAgentMessage(message);
    const provider = ownedAgentProvider(message);
    const senderName = normalizedName(message.sender?.name);
    const senderIdentity = normalizedName(message.sender?.relayUserId) ? `user:${normalizedName(message.sender?.relayUserId)}` : `name:${senderName.toLowerCase() || "unknown"}`;
    if (ownedAgent) {
      const agentIdentity = provider || normalizedName(message.source?.surface).toLowerCase() || "unknown";
      const providerLabel = provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : "Agent";
      return {
        key: outbound ? `owned-agent:${agentIdentity}` : `agent:${senderIdentity}:${agentIdentity}`,
        label: outbound ? `My ${providerLabel}` : senderName || providerLabel,
        outbound,
        ownedAgent: true,
        ...provider ? { provider } : {}
      };
    }
    return {
      key: `${direction}:${senderIdentity}`,
      label: senderName,
      outbound,
      ownedAgent: false
    };
  }
  function isActiveOwnedAgentMessage(message) {
    return isOwnedAgentMessage(message) && !message.deletedAt && !normalizedName(message.forAgent) && !normalizedName(message.agent);
  }
  function idleChatLiveFollowState() {
    return { roomKey: null, following: false };
  }
  function reduceChatLiveFollow(state, event) {
    const roomKey = normalizedName(event.type === "reset" ? "" : event.roomKey);
    if (event.type === "agent-sent") return { roomKey, following: Boolean(roomKey) };
    if (event.type === "reset") return idleChatLiveFollowState();
    if (event.type === "room-left") {
      return !event.roomKey || state.roomKey === roomKey ? idleChatLiveFollowState() : state;
    }
    if (state.roomKey !== roomKey) return state;
    if (event.type === "user-scrolled" || event.type === "agent-finished") {
      return idleChatLiveFollowState();
    }
    return state;
  }
  function shouldPinChatLiveFollow(state, roomKey) {
    return state.following && state.roomKey === normalizedName(roomKey);
  }
  return __toCommonJS(chat_presentation_exports);
})();
