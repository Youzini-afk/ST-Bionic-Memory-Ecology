// ST-BME: SillyTavern 上下文数据读取辅助
// 为 prompt 变量扩展（Phase 2）提供统一的 ST 上下文数据接口

import { getContext } from "../../../extensions.js";

/**
 * 从 SillyTavern 的 getContext() 提取当前上下文数据，
 * 返回的字段可直接展开传入 buildTaskPrompt 的 context 参数，
 * 用户在自定义 prompt 块中可通过 {{key}} 引用。
 *
 * @returns {object} 上下文字段映射
 */
export function getSTContextForPrompt() {
  try {
    const ctx = getContext?.() || {};
    const charId = ctx.characterId;
    const char =
      ctx.characters?.[Number(charId)] ||
      ctx.characters?.[charId] ||
      null;

    return {
      userPersona:
        ctx.powerUserSettings?.persona_description ||
        ctx.extensionSettings?.persona_description ||
        ctx.name1_description ||
        ctx.persona ||
        "",
      charDescription:
        char?.description ||
        char?.data?.description ||
        "",
      charName: ctx.name2 || "",
      userName: ctx.name1 || "",
      currentTime: new Date().toLocaleString("zh-CN"),
    };
  } catch (e) {
    console.warn("[ST-BME] getSTContextForPrompt 失败:", e);
    return {
      userPersona: "",
      charDescription: "",
      charName: "",
      userName: "",
      currentTime: new Date().toLocaleString("zh-CN"),
    };
  }
}
