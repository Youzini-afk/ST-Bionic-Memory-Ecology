export const RECALL_PROMPT_KEY = "st_bme_v9_recall";

const NO_NEW_USER_TYPES = new Set(["swipe", "regenerate", "continue"]);
const SKIPPED_TYPES = new Set(["quiet", "impersonate", "append", "appendfinal"]);

export function classifyGeneration(type, params = {}, dryRun = false) {
  const normalizedType = String(type || "normal").trim().toLowerCase() || "normal";
  if (
    dryRun ||
    params?.automatic_trigger ||
    params?.quiet_prompt ||
    SKIPPED_TYPES.has(normalizedType)
  ) {
    return { type: normalizedType, kind: "skip" };
  }
  if (NO_NEW_USER_TYPES.has(normalizedType)) {
    return { type: normalizedType, kind: "no-new-user" };
  }
  return {
    type: normalizedType,
    kind: normalizedType === "normal" ? "fresh-candidate" : "skip",
  };
}

function messageRole(message, visibleIndex) {
  if (message?.is_system) return "system";
  if (message?.is_user) return "user";
  return visibleIndex === 0 ? "greeting" : "assistant";
}

function isVisibleMessage(message) {
  return Boolean(message && typeof message === "object" && !message.extra?.isSmallSys);
}

function freezeMessages(chat, context) {
  const messages = [];
  for (let hostIndex = 0; hostIndex < chat.length; hostIndex += 1) {
    const message = chat[hostIndex];
    if (!isVisibleMessage(message)) continue;
    const role = messageRole(message, messages.length);
    const fallbackSpeaker = role === "user" ? context.name1 : context.name2;
    messages.push(Object.freeze({
      role,
      speaker: String(message.name || fallbackSpeaker || ""),
      text: String(message.mes ?? ""),
      hostIndex,
    }));
  }
  return Object.freeze(messages);
}

export class StHostAdapter {
  #getContext;
  #getCurrentChatId;
  #prompt;
  #logger;
  #document;
  #plannerReplay = false;

  constructor({
    getContext,
    getCurrentChatId = null,
    prompt = {},
    documentLike = globalThis.document,
    logger = console,
  } = {}) {
    if (typeof getContext !== "function") throw new TypeError("getContext is required");
    this.#getContext = getContext;
    this.#getCurrentChatId = getCurrentChatId;
    this.#logger = logger;
    this.#document = documentLike;
    this.#prompt = {
      key: String(prompt.key || RECALL_PROMPT_KEY),
      position: Number.isFinite(Number(prompt.position)) ? Number(prompt.position) : 1,
      depth: Number.isFinite(Number(prompt.depth)) ? Number(prompt.depth) : 9999,
      role: Number.isFinite(Number(prompt.role)) ? Number(prompt.role) : 0,
    };
  }

  snapshotConversation() {
    const context = this.#getContext() || {};
    const chatKey = String(
      context.chatId || this.#getCurrentChatId?.() || "",
    ).trim();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    return Object.freeze({
      chatKey,
      rawLength: chat.length,
      messages: freezeMessages(chat, context),
    });
  }

  findUserByHostIndex(snapshot, hostIndexInput) {
    const hostIndex = Number(hostIndexInput);
    if (!Number.isSafeInteger(hostIndex) || hostIndex < 0) return null;
    return snapshot.messages.find(
      (message) => message.hostIndex === hostIndex && message.role === "user",
    ) || null;
  }

  findParentUser(snapshot, assistantHostIndex = null) {
    const targetIndex = Number(assistantHostIndex);
    let position = snapshot.messages.length - 1;
    if (
      assistantHostIndex !== null &&
      assistantHostIndex !== undefined &&
      assistantHostIndex !== "" &&
      Number.isSafeInteger(targetIndex) &&
      targetIndex >= 0
    ) {
      const assistantPosition = snapshot.messages.findIndex(
        ({ hostIndex }) => hostIndex === targetIndex,
      );
      if (assistantPosition >= 0) position = assistantPosition - 1;
    }
    for (; position >= 0; position -= 1) {
      if (snapshot.messages[position].role === "user") return snapshot.messages[position];
    }
    return null;
  }

  historyThrough(snapshot, message) {
    const position = snapshot.messages.indexOf(message);
    if (position < 0) throw new TypeError("message does not belong to snapshot");
    return snapshot.messages.slice(0, position + 1);
  }

  setRecallInjection(value) {
    const context = this.#getContext() || {};
    const setter = context.setExtensionPrompt;
    if (typeof setter !== "function") throw new Error("setExtensionPrompt is unavailable");
    Reflect.apply(setter, context, [
      this.#prompt.key,
      String(value ?? ""),
      this.#prompt.position,
      this.#prompt.depth,
      false,
      this.#prompt.role,
    ]);
  }

  clearRecallInjection() {
    this.setRecallInjection("");
  }

  resumeUserSend(value, expectedValue = undefined) {
    const textarea = this.#document?.getElementById?.("send_textarea");
    const button = this.#document?.getElementById?.("send_but") ||
      this.#document?.getElementById?.("send_button");
    if (!textarea || typeof button?.click !== "function") {
      throw new Error("SillyTavern send controls are unavailable");
    }
    if (expectedValue !== undefined && textarea.value !== String(expectedValue ?? "")) {
      return false;
    }
    textarea.value = String(value ?? "");
    this.#plannerReplay = true;
    try {
      button.click();
    } finally {
      this.#plannerReplay = false;
    }
    return true;
  }

  bindPlannerSend(coordinator) {
    if (
      typeof coordinator?.decideUserSend !== "function" ||
      typeof coordinator?.handleUserSend !== "function"
    ) {
      throw new TypeError("PlannerSendCoordinator is required");
    }
    if (!this.#document?.addEventListener) {
      throw new Error("SillyTavern document is unavailable");
    }
    const intercept = (event) => {
      if (this.#plannerReplay) return;
      const stopButton = this.#document.getElementById("mes_stop");
      if (stopButton?.style?.display && stopButton.style.display !== "none") return;
      const textarea = this.#document.getElementById("send_textarea");
      if (!textarea) return;
      const decision = coordinator.decideUserSend(textarea.value);
      if (!decision.intercept) return;
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      Promise.resolve(coordinator.handleUserSend(textarea.value, decision)).catch((error) => {
        this.#logger?.error?.("[ST-BME v9] planner send interception failed", error);
      });
    };
    const onClick = (event) => {
      const button = this.#document.getElementById("send_but") ||
        this.#document.getElementById("send_button");
      if (!button || (event.target !== button && !button.contains?.(event.target))) return;
      intercept(event);
    };
    const onKeydown = (event) => {
      const textarea = this.#document.getElementById("send_textarea");
      const shouldSendOnEnter = this.#getContext()?.shouldSendOnEnter;
      if (
        event.target !== textarea ||
        event.key !== "Enter" ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.isComposing ||
        typeof shouldSendOnEnter !== "function" ||
        !shouldSendOnEnter()
      ) return;
      intercept(event);
    };
    this.#document.addEventListener("click", onClick, true);
    this.#document.addEventListener("keydown", onKeydown, true);
    return () => {
      this.#document.removeEventListener?.("click", onClick, true);
      this.#document.removeEventListener?.("keydown", onKeydown, true);
    };
  }

  bind(coordinator) {
    const context = this.#getContext() || {};
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes || {};
    if (!eventSource?.on) throw new Error("SillyTavern eventSource is unavailable");

    const cleanups = [];
    const backgroundTimers = new Set();
    const safe = (name, listener) => async (...args) => {
      try {
        return await listener(...args);
      } catch (error) {
        this.#logger?.error?.(`[ST-BME v9] ${name} failed`, error);
        return { status: "failed", error };
      }
    };
    const bind = (eventName, name, listener, first = false) => {
      if (!eventName || typeof listener !== "function") return;
      const wrapped = safe(name, listener);
      if (first && typeof eventSource.makeFirst === "function") {
        const cleanup = eventSource.makeFirst(eventName, wrapped);
        if (typeof cleanup === "function") cleanups.push(cleanup);
        else if (typeof eventSource.off === "function") {
          cleanups.push(() => eventSource.off(eventName, wrapped));
        } else if (typeof eventSource.removeListener === "function") {
          cleanups.push(() => eventSource.removeListener(eventName, wrapped));
        }
        return;
      }
      eventSource.on(eventName, wrapped);
      if (typeof eventSource.off === "function") {
        cleanups.push(() => eventSource.off(eventName, wrapped));
      } else if (typeof eventSource.removeListener === "function") {
        cleanups.push(() => eventSource.removeListener(eventName, wrapped));
      }
    };
    const background = (name, listener) => (...args) => {
      const timer = setTimeout(async () => {
        backgroundTimers.delete(timer);
        try {
          await listener(...args);
        } catch (error) {
          this.#logger?.error?.(`[ST-BME v9] ${name} failed`, error);
        }
      }, 0);
      backgroundTimers.add(timer);
      return { status: "scheduled" };
    };

    bind(eventTypes.CHAT_CHANGED, "chat change", () => coordinator.onChatChanged());
    bind(eventTypes.CHAT_LOADED, "chat load", () => coordinator.onChatChanged());
    bind(eventTypes.GENERATION_STARTED, "generation start", (...args) =>
      coordinator.onGenerationStarted(...args));
    bind(eventTypes.GENERATION_AFTER_COMMANDS, "generation commands", (...args) =>
      coordinator.onGenerationAfterCommands(...args), true);
    bind(eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, "prompt preparation", (promptData) =>
      coordinator.onBeforeCombinePrompts(promptData), true);
    bind(eventTypes.MESSAGE_SENT, "message sent", (messageId) =>
      coordinator.onMessageSent(messageId));
    bind(eventTypes.MESSAGE_RECEIVED, "message received", background(
      "message received",
      (messageId, type) => coordinator.onMessageReceived(messageId, type),
    ));
    const historyEvents = new Map([
      [eventTypes.MESSAGE_DELETED, "message deleted"],
      [eventTypes.MESSAGE_EDITED, "message edited"],
      [eventTypes.MESSAGE_UPDATED, "message updated"],
      [eventTypes.MESSAGE_SWIPED, "message swiped"],
      [eventTypes.MESSAGE_SWIPE_DELETED, "message swipe deleted"],
    ].filter(([eventName]) => eventName));
    for (const [eventName, name] of historyEvents) {
      bind(eventName, name, (...args) => coordinator.onHistoryChanged(name, ...args));
    }
    bind(eventTypes.GENERATION_STOPPED, "generation stopped", () =>
      coordinator.onGenerationFinished("stopped"));
    bind(eventTypes.GENERATION_ENDED, "generation ended", () =>
      coordinator.onGenerationFinished("ended"));

    return () => {
      for (const timer of backgroundTimers) clearTimeout(timer);
      backgroundTimers.clear();
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
  }
}
