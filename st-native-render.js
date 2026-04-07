import { substituteParamsExtended } from "../../../../script.js";
import jsyaml from "./vendor/js-yaml.mjs";

function getTemplateRuntime() {
  return globalThis.window?.EjsTemplate || globalThis.EjsTemplate || null;
}

function safeStringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function deepGet(target, path) {
  if (!target || !path) return undefined;
  const parts = String(path || "")
    .split(".")
    .filter(Boolean);
  let current = target;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

export function getLatestMessageVarTable() {
  try {
    if (globalThis.window?.Mvu?.getMvuData) {
      return (
        globalThis.window.Mvu.getMvuData({
          type: "message",
          message_id: "latest",
        }) || {}
      );
    }
  } catch {
    // ignore
  }

  try {
    const getVars =
      globalThis.window?.TavernHelper?.getVariables ||
      globalThis.window?.Mvu?.getMvuData ||
      globalThis.TavernHelper?.getVariables ||
      globalThis.Mvu?.getMvuData;
    if (typeof getVars === "function") {
      return getVars({ type: "message", message_id: "latest" }) || {};
    }
  } catch {
    // ignore
  }

  return {};
}

export async function prepareStNativeEjsEnv() {
  try {
    const runtime = getTemplateRuntime();
    const prepare =
      runtime?.prepareContext || runtime?.preparecontext || null;
    if (typeof prepare !== "function") {
      return null;
    }
    return (await prepare.call(runtime, {})) || null;
  } catch {
    return null;
  }
}

function substituteMacrosViaST(text) {
  try {
    if (typeof substituteParamsExtended === "function") {
      return substituteParamsExtended(text);
    }
  } catch {
    // ignore
  }
  return text;
}

function resolveGetMessageVariableMacros(text, messageVars) {
  return String(text || "").replace(
    /\{\{\s*get_message_variable::([^}]+)\s*}}/g,
    (_, rawPath) => {
      const path = String(rawPath || "").trim();
      if (!path) return "";
      return safeStringify(deepGet(messageVars, path));
    },
  );
}

function resolveFormatMessageVariableMacros(text, messageVars) {
  return String(text || "").replace(
    /\{\{\s*format_message_variable::([^}]+)\s*}}/g,
    (_, rawPath) => {
      const path = String(rawPath || "").trim();
      if (!path) return "";
      const value = deepGet(messageVars, path);
      if (value == null) return "";
      if (typeof value === "string") return value;
      try {
        return jsyaml.dump(value, {
          lineWidth: -1,
          noRefs: true,
        });
      } catch {
        return safeStringify(value);
      }
    },
  );
}

export async function renderTemplateWithStSupport(
  text,
  { env = null, messageVars = null, evaluateEjs = true } = {},
) {
  const originalText = String(text ?? "");
  const runtime = getTemplateRuntime();
  const effectiveEnv = env || null;
  const effectiveMessageVars =
    messageVars && typeof messageVars === "object"
      ? messageVars
      : getLatestMessageVarTable();

  let output = originalText;
  let ejsEvaluated = false;
  let ejsError = null;

  if (evaluateEjs && originalText.includes("<%")) {
    try {
      const evalTemplate =
        runtime?.evalTemplate || runtime?.evaltemplate || null;
      if (runtime && effectiveEnv && typeof evalTemplate === "function") {
        output = await evalTemplate.call(runtime, output, effectiveEnv);
        ejsEvaluated = true;
      }
    } catch (error) {
      ejsError = error;
    }
  }

  const afterMacroSubstitute = substituteMacrosViaST(output);
  const afterMessageVariableResolve = resolveFormatMessageVariableMacros(
    resolveGetMessageVariableMacros(afterMacroSubstitute, effectiveMessageVars),
    effectiveMessageVars,
  );

  return {
    text: afterMessageVariableResolve,
    stNativeRuntimeAvailable: Boolean(runtime),
    envPrepared: Boolean(effectiveEnv),
    ejsEvaluated,
    ejsError,
    macroApplied: afterMacroSubstitute !== output,
    messageVariableMacrosApplied:
      afterMessageVariableResolve !== afterMacroSubstitute,
  };
}
