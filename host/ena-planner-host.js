import { getContext } from "./st-extensions.js";
import { getHostDocument, getHostWindow } from "./st-runtime.js";

let worldInfoModulePromise = null;

export function getPlannerHostContext() {
  try {
    return getContext?.() || getHostWindow()?.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

export function getPlannerHostWindowLike() {
  return getHostWindow();
}

export function getPlannerTavernHelper() {
  const hostWindow = getHostWindow();
  return hostWindow?.TavernHelper || hostWindow?.SillyTavern?.TavernHelper || null;
}

export function getPlannerCurrentCharacter() {
  const context = getPlannerHostContext();
  const hostWindow = getHostWindow();
  const characterId =
    context?.characterId ??
    context?.this_chid ??
    hostWindow?.SillyTavern?.this_chid ??
    hostWindow?.this_chid;
  const characters =
    context?.characters || hostWindow?.SillyTavern?.characters || hostWindow?.characters;
  return characters && characterId != null ? characters[characterId] ?? null : null;
}

export function getPlannerCharacterGlobalsDebug() {
  const hostWindow = getHostWindow();
  return {
    characterId: hostWindow?.this_chid,
    characterCount: hostWindow?.characters?.length ?? "N/A",
  };
}

export function getPlannerHostChat() {
  const context = getPlannerHostContext();
  return context?.chat ?? getHostWindow()?.SillyTavern?.chat ?? [];
}

export function getPlannerChatMetadataVariables() {
  return getHostWindow()?.chat_metadata?.variables || null;
}

export function getPlannerHostEjs() {
  return getHostWindow()?.ejs || null;
}

export function getPlannerHostEjsTemplate() {
  return getHostWindow()?.EjsTemplate || null;
}

export function getPlannerLatestMessageVariables() {
  const hostWindow = getHostWindow();
  try {
    if (typeof hostWindow?.Mvu?.getMvuData === "function") {
      return hostWindow.Mvu.getMvuData({ type: "message", message_id: "latest" });
    }
  } catch {}

  try {
    const getVariables = hostWindow?.TavernHelper?.getVariables || hostWindow?.Mvu?.getMvuData;
    if (typeof getVariables === "function") {
      return getVariables({ type: "message", message_id: "latest" });
    }
  } catch {}

  return {};
}

export function getPlannerSendTextarea() {
  return getHostDocument()?.getElementById?.("send_textarea") || null;
}

export function getPlannerSendButton() {
  const document = getHostDocument();
  return document?.getElementById?.("send_but") || document?.getElementById?.("send_button") || null;
}

export function setPlannerSendBusy(busy) {
  const button = getPlannerSendButton();
  const textarea = getPlannerSendTextarea();
  if (button) button.disabled = Boolean(busy);
  if (textarea) textarea.disabled = Boolean(busy);
}

export function addPlannerSendListeners(clickHandler, keydownHandler) {
  const document = getHostDocument();
  document?.addEventListener?.("click", clickHandler, true);
  document?.addEventListener?.("keydown", keydownHandler, true);
}

export function removePlannerSendListeners(clickHandler, keydownHandler) {
  const document = getHostDocument();
  if (clickHandler) document?.removeEventListener?.("click", clickHandler, true);
  if (keydownHandler) document?.removeEventListener?.("keydown", keydownHandler, true);
}

export function showPlannerHostError(message) {
  const showError = getHostWindow()?.toastr?.error;
  if (typeof showError !== "function") return false;
  showError(message);
  return true;
}

export async function getPlannerWorldInfoModule() {
  if (!worldInfoModulePromise) {
    worldInfoModulePromise = import("/scripts/world-info.js").catch(() => null);
  }
  return await worldInfoModulePromise;
}
