const encoder = new TextEncoder();

export const EMPTY_HISTORY_HASH = "0".repeat(64);

const ROLES = new Set(["user", "assistant", "system", "greeting"]);

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeSemanticMessage(message, index = 0) {
  if (!message || typeof message !== "object") {
    throw new TypeError(`history message ${index} must be an object`);
  }

  const role = String(message.role || "").trim().toLowerCase();
  if (!ROLES.has(role)) {
    throw new TypeError(`history message ${index} has invalid role`);
  }

  return {
    role,
    speaker: normalizeText(message.speaker).trim(),
    text: normalizeText(message.text),
  };
}

export async function snapshotHistory(messages = []) {
  if (!Array.isArray(messages)) throw new TypeError("history must be an array");

  const history = [];
  let previousPrefixHash = EMPTY_HISTORY_HASH;

  for (let index = 0; index < messages.length; index += 1) {
    const message = normalizeSemanticMessage(messages[index], index);
    const messageHash = await sha256Hex(JSON.stringify([
      message.role,
      message.speaker,
      message.text,
    ]));
    const prefixHash = await sha256Hex(`${previousPrefixHash}:${messageHash}`);
    history.push({ ...message, messageHash, prefixHash });
    previousPrefixHash = prefixHash;
  }

  return history;
}

export function toHistoryIdentity(history = []) {
  if (!Array.isArray(history)) throw new TypeError("history must be an array");
  return history.map(({ messageHash, prefixHash }, index) => {
    const normalizedMessageHash = String(messageHash || "");
    const normalizedPrefixHash = String(prefixHash || "");
    if (!normalizedMessageHash || !normalizedPrefixHash) {
      throw new TypeError(`history identity ${index} is incomplete`);
    }
    return {
      messageHash: normalizedMessageHash,
      prefixHash: normalizedPrefixHash,
    };
  });
}

export function findCommonPrefixLength(left = [], right = []) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < limit &&
    String(left[index]?.messageHash || "") === String(right[index]?.messageHash || "")
  ) {
    index += 1;
  }
  return index;
}

export function getHistoryPrefixHash(history = [], length = history.length) {
  const normalizedLength = Math.floor(Number(length));
  if (!Number.isFinite(normalizedLength) || normalizedLength < 0 || normalizedLength > history.length) {
    throw new RangeError("history prefix length is out of range");
  }
  return normalizedLength === 0
    ? EMPTY_HISTORY_HASH
    : String(history[normalizedLength - 1]?.prefixHash || "");
}

export function historyBasisMatches(history, length, expectedHash) {
  try {
    return getHistoryPrefixHash(history, length) === String(expectedHash || "");
  } catch {
    return false;
  }
}

export async function buildTurnKey(chatKey, historyPrefixHash) {
  const normalizedChatKey = String(chatKey || "").trim();
  const normalizedPrefixHash = String(historyPrefixHash || "").trim();
  if (!normalizedChatKey || !normalizedPrefixHash) {
    throw new TypeError("chatKey and historyPrefixHash are required");
  }
  return sha256Hex(`st-bme:v9:turn\0${normalizedChatKey}\0${normalizedPrefixHash}`);
}

export async function assertTurnKeyBinding(chatKey, historyPrefixHash, turnKey) {
  const actual = String(turnKey || "").trim();
  const expected = await buildTurnKey(chatKey, historyPrefixHash);
  if (actual !== expected) throw new TypeError("turnKey does not match chat history binding");
  return actual;
}
