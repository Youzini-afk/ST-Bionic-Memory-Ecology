import { getWorldInfoPrompt, wi_anchor_position } from "../../../../world-info.js";

const ROLE_NAMES = Object.freeze(["system", "user", "assistant"]);

function textOf(message) {
  if (typeof message === "string") return message.trim();
  const text = String(message?.mes ?? message?.content ?? "").trim();
  const name = String(message?.name ?? "").trim();
  return name && text ? `${name}: ${text}` : text;
}

function entry(content, bucket, index, extras = {}) {
  return {
    uid: index,
    name: `SillyTavern world info ${bucket} ${index + 1}`,
    sourceName: "SillyTavern",
    worldbook: "",
    content: String(content || "").trim(),
    role: extras.role ?? "system",
    position: bucket,
    depth: Number(extras.depth ?? 0),
    order: index,
    index,
    activationDebug: { mode: "host-native" },
  };
}

function depthEntries(groups = []) {
  return (Array.isArray(groups) ? groups : []).flatMap((group, groupIndex) => {
    const content = (Array.isArray(group?.entries) ? group.entries : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n");
    if (!content) return [];
    const numericRole = Number(group?.role);
    return [entry(content, "atDepth", groupIndex, {
      depth: Number.isFinite(Number(group?.depth)) ? Number(group.depth) : 0,
      role: ROLE_NAMES[numericRole] ?? "system",
    })];
  });
}

function additionalMessages(entries = []) {
  return entries.map((item) => ({
    role: item.role,
    content: item.content,
    depth: item.depth,
    order: item.order,
    uid: item.uid,
    index: item.index,
    name: item.name,
    sourceName: item.sourceName,
    worldbook: item.worldbook,
    source: "worldInfo-atDepth",
    sourceKey: "taskAdditionalMessages",
  }));
}

function emptyResult() {
  return {
    beforeEntries: [],
    afterEntries: [],
    atDepthEntries: [],
    beforeText: "",
    afterText: "",
    additionalMessages: [],
    activatedEntryNames: [],
    allEntries: [],
    debug: {
      sourceLabel: "SillyTavern.getWorldInfoPrompt",
      fallback: false,
      activatedEntryCount: 0,
      warnings: [],
      resolvedEntries: [],
    },
  };
}

function scanData(context = {}) {
  return {
    personaDescription: String(context.userPersona || ""),
    characterDescription: String(context.charDescription || ""),
    characterPersonality: String(context.charPersonality || ""),
    characterDepthPrompt: String(context.charDepthPrompt || ""),
    scenario: String(context.scenario || ""),
    creatorNotes: String(context.creatorNotes || ""),
    trigger: "normal",
  };
}

export async function resolveTaskWorldInfo({
  chatMessages = [],
  userMessage = "",
  templateContext = {},
} = {}) {
  const result = emptyResult();
  const messages = (Array.isArray(chatMessages) ? chatMessages : [])
    .map(textOf)
    .filter(Boolean);
  const latestUser = String(userMessage || "").trim();
  if (latestUser && messages.at(-1) !== latestUser) messages.push(latestUser);

  try {
    const native = await getWorldInfoPrompt(
      messages.reverse(),
      32768,
      true,
      scanData(templateContext),
    );
    const beforeParts = [
      native.worldInfoBefore,
      ...(Array.isArray(native.worldInfoExamples)
        ? native.worldInfoExamples
            .filter((item) => item?.position === wi_anchor_position.before)
            .map((item) => item.content)
        : []),
      ...(Array.isArray(native.anBefore) ? native.anBefore : []),
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const afterParts = [
      native.worldInfoAfter,
      ...(Array.isArray(native.worldInfoExamples)
        ? native.worldInfoExamples
            .filter((item) => item?.position !== wi_anchor_position.before)
            .map((item) => item.content)
        : []),
      ...(Array.isArray(native.anAfter) ? native.anAfter : []),
      ...Object.values(native.outletEntries || {}).flat(),
    ].map((value) => String(value || "").trim()).filter(Boolean);

    result.beforeEntries = beforeParts.map((content, index) => entry(content, "before", index));
    result.afterEntries = afterParts.map((content, index) => entry(content, "after", index));
    result.atDepthEntries = depthEntries(native.worldInfoDepth);
    result.beforeText = beforeParts.join("\n\n");
    result.afterText = afterParts.join("\n\n");
    result.additionalMessages = additionalMessages(result.atDepthEntries);
    result.debug.activatedEntryCount =
      result.beforeEntries.length + result.afterEntries.length + result.atDepthEntries.length;
    result.debug.resolvedEntries = [
      ...result.beforeEntries,
      ...result.afterEntries,
      ...result.atDepthEntries,
    ].map(({ name, position, role, depth }) => ({ name, bucket: position, role, depth }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.debug.warnings.push(`SillyTavern world info failed: ${message}`);
    console.error("[ST-BME] SillyTavern world info failed", error);
  }
  return result;
}
