import { createDomainId } from "../domain/memory-id.js";

export const BME_CHAT_IDENTITY_METADATA_KEY = "bme_memory_identity";

export class ConversationIdentityConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ConversationIdentityConflictError";
    this.code = "conversation_identity_conflict";
    this.details = details;
  }
}

function normalizeIdentity(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const chatId = String(value.chatId || "").trim();
  const lineageId = String(value.lineageId || "").trim();
  if (!chatId || !lineageId) return null;
  return {
    chatId,
    lineageId,
    parentChatId: String(value.parentChatId || "").trim(),
    hostChatId: String(value.hostChatId || "").trim(),
    hostChatIds: [
      ...new Set(
        [value.hostChatId, ...(Array.isArray(value.hostChatIds) ? value.hostChatIds : [])]
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      ),
    ],
    integrity: String(value.integrity || "").trim(),
    branchCutoff:
      value.branchCutoff !== null &&
      value.branchCutoff !== undefined &&
      value.branchCutoff !== "" &&
      Number.isFinite(Number(value.branchCutoff))
      ? Math.floor(Number(value.branchCutoff))
      : null,
  };
}

export class ConversationIdentityRegistry {
  constructor(entries = []) {
    this._byChatId = new Map();
    this._byHostChatId = new Map();
    for (const entry of entries || []) this.register(entry);
  }

  register(identity) {
    const normalized = normalizeIdentity(identity);
    if (!normalized) throw new TypeError("invalid conversation identity");
    const existing = this._byChatId.get(normalized.chatId);
    const merged = {
      ...existing,
      ...normalized,
      hostChatIds: [
        ...new Set([
          ...(existing?.hostChatIds || []),
          ...normalized.hostChatIds,
        ]),
      ],
    };
    for (const hostChatId of merged.hostChatIds) {
      const mappedChatId = this._byHostChatId.get(hostChatId);
      if (mappedChatId && mappedChatId !== merged.chatId) {
        throw new ConversationIdentityConflictError(
          `host chat locator already belongs to another chat: ${hostChatId}`,
          { hostChatId, existingChatId: mappedChatId, incomingChatId: merged.chatId },
        );
      }
    }
    this._byChatId.set(merged.chatId, merged);
    for (const hostChatId of merged.hostChatIds) {
      this._byHostChatId.set(hostChatId, merged.chatId);
    }
    return merged;
  }

  findByChatId(chatId) {
    return this._byChatId.get(String(chatId || "").trim()) || null;
  }

  findByHostChatId(hostChatId) {
    const chatId = this._byHostChatId.get(String(hostChatId || "").trim());
    return chatId ? this.findByChatId(chatId) : null;
  }

  findRootByIntegrity(integrity) {
    const normalized = String(integrity || "").trim();
    if (!normalized) return null;
    return (
      [...this._byChatId.values()].find(
        (identity) => identity.integrity === normalized && !identity.parentChatId,
      ) || null
    );
  }

  toJSON() {
    return [...this._byChatId.values()].map((identity) => ({ ...identity }));
  }
}

export function resolveConversationIdentity(
  context = {},
  { registry = new ConversationIdentityRegistry(), branch = null } = {},
) {
  const metadata =
    context.chatMetadata && typeof context.chatMetadata === "object"
      ? context.chatMetadata
      : {};
  const persisted = normalizeIdentity(metadata[BME_CHAT_IDENTITY_METADATA_KEY]);
  const hostChatId = String(
    context.hostChatId || context.chatId || context.groupChatId || "",
  ).trim();
  const integrity = String(metadata.integrity || context.integrity || "").trim();
  if (!hostChatId && !integrity) {
    throw new TypeError("conversation identity requires hostChatId or integrity");
  }
  if (persisted) {
    const identity = registry.register({
      ...persisted,
      hostChatId: hostChatId || persisted.hostChatId,
      integrity: integrity || persisted.integrity,
    });
    return { identity, metadataPatch: { [BME_CHAT_IDENTITY_METADATA_KEY]: identity } };
  }

  const existingByHost = registry.findByHostChatId(hostChatId);
  if (existingByHost) {
    if (
      integrity &&
      existingByHost.integrity &&
      integrity !== existingByHost.integrity
    ) {
      throw new ConversationIdentityConflictError(
        `host chat locator integrity changed: ${hostChatId}`,
        {
          hostChatId,
          expectedIntegrity: existingByHost.integrity,
          actualIntegrity: integrity,
        },
      );
    }
    return {
      identity: existingByHost,
      metadataPatch: { [BME_CHAT_IDENTITY_METADATA_KEY]: existingByHost },
    };
  }

  const mainChat = String(
    branch?.sourceHostChatId || metadata.main_chat || metadata.mainChat || "",
  ).trim();
  const isBranch = Boolean(branch || mainChat);
  let identity = null;
  if (isBranch) {
    const source =
      registry.findByHostChatId(mainChat) || registry.findRootByIntegrity(integrity);
    const lineageId =
      source?.lineageId || createDomainId("lineage", { integrity, mainChat, root: true });
    identity = {
      chatId: createDomainId("chat", {
        lineageId,
        hostChatId,
        mainChat,
        branchName: branch?.branchName || "",
      }),
      lineageId,
      parentChatId: source?.chatId || "",
      hostChatId,
      integrity,
      branchCutoff: Number.isFinite(Number(branch?.cutoffFloor))
        ? Math.floor(Number(branch.cutoffFloor))
        : null,
    };
  } else {
    const root = registry.findRootByIntegrity(integrity);
    identity = root
      ? { ...root, hostChatId: hostChatId || root.hostChatId }
      : {
          chatId: createDomainId("chat", { integrity, hostChatId }),
          lineageId: createDomainId("lineage", { integrity, hostChatId }),
          parentChatId: "",
          hostChatId,
          integrity,
          branchCutoff: null,
        };
  }
  identity = registry.register(identity);
  return { identity, metadataPatch: { [BME_CHAT_IDENTITY_METADATA_KEY]: identity } };
}
