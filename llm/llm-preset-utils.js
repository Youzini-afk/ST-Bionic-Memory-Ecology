function normalizeLlmConfigValue(value) {
  return String(value || "").trim();
}

 const OPENAI_COMPATIBLE_PROVIDER_LABELS = {
   openai: "OpenAI",
   openrouter: "OpenRouter",
   deepseek: "DeepSeek",
   xai: "xAI",
   mistral: "Mistral",
   moonshot: "Moonshot",
   zai: "Z.AI",
   groq: "Groq",
   siliconflow: "SiliconFlow",
   aimlapi: "AI/ML API",
   fireworks: "Fireworks",
   nanogpt: "NanoGPT",
   chutes: "Chutes",
   electronhub: "ElectronHub",
   "volcengine-ark": "火山方舟 Ark",
   "custom-openai-compatible": "自定义 OpenAI 兼容渠道",
 };

 function tryParseLlmUrl(value) {
   const normalized = normalizeLlmConfigValue(value);
   if (!normalized) return null;

   try {
     return new URL(normalized);
   } catch {
     return null;
   }
 }

 function normalizeParsedUrlString(parsedUrl) {
   if (!parsedUrl) return "";
   const cloned = new URL(parsedUrl.toString());
   cloned.search = "";
   cloned.hash = "";
   return String(cloned.toString()).replace(/\/+$/, "");
 }

 function stripOpenAiCompatibleEndpointSuffix(value) {
   return String(value || "")
     .replace(/\/+((chat|text)\/completions|completions|embeddings|models)$/i, "")
     .replace(/\/+$/, "");
 }

 function stripAnthropicEndpointSuffix(value) {
   return String(value || "")
     .replace(/\/+messages$/i, "")
     .replace(/\/+$/, "");
 }

 function stripGoogleAiStudioEndpointSuffix(value) {
   return String(value || "")
     .replace(
       /\/+v\d+(?:beta)?\/models(?:\/[^/:?#]+:(?:streamGenerateContent|generateContent))?$/i,
       "",
     )
     .replace(/\/+$/, "");
 }

 function resolveKnownOpenAiCompatibleProviderId(parsedUrl) {
   const hostname = String(parsedUrl?.hostname || "").trim().toLowerCase();
   const pathname = String(parsedUrl?.pathname || "").trim().toLowerCase();

   if (!hostname) {
     return "custom-openai-compatible";
   }

   if (hostname.includes("openai.com")) return "openai";
   if (hostname.includes("openrouter.ai")) return "openrouter";
   if (hostname.includes("deepseek.com")) return "deepseek";
   if (hostname === "x.ai" || hostname === "api.x.ai" || hostname.endsWith(".x.ai")) {
     return "xai";
   }
   if (hostname.includes("mistral.ai")) return "mistral";
   if (hostname.includes("moonshot.ai")) return "moonshot";
   if (hostname === "api.z.ai" || hostname.endsWith(".z.ai")) return "zai";
   if (hostname.includes("groq.com")) return "groq";
   if (hostname.includes("siliconflow.com")) return "siliconflow";
   if (hostname.includes("aimlapi.com")) return "aimlapi";
   if (hostname.includes("fireworks.ai")) return "fireworks";
   if (hostname.includes("nano-gpt.com")) return "nanogpt";
   if (hostname.includes("chutes.ai")) return "chutes";
   if (hostname.includes("electronhub.ai")) return "electronhub";
   if (
     hostname.includes("volces.com") ||
     hostname.startsWith("ark.") ||
     pathname.includes("/api/coding/v3")
   ) {
     return "volcengine-ark";
   }

   return "custom-openai-compatible";
 }

 function createResolvedDedicatedProviderConfig(overrides = {}) {
   return {
     inputUrl: "",
     apiUrl: "",
     providerId: "",
     providerLabel: "",
     transportId: "",
     transportLabel: "",
     hostSource: "",
     hostSourceConst: "",
     routeMode: "",
     supportsModelFetch: false,
     statusStrategies: [],
     isKnownProvider: false,
     isOpenAiCompatible: false,
     ...overrides,
   };
 }

 export function resolveDedicatedLlmProviderConfig(value = "") {
   const normalizedInput = normalizeLlmConfigValue(value);
   if (!normalizedInput) {
     return createResolvedDedicatedProviderConfig();
   }

   const parsedUrl = tryParseLlmUrl(normalizedInput);
   if (!parsedUrl) {
     return createResolvedDedicatedProviderConfig({
       inputUrl: normalizedInput,
       apiUrl: normalizedInput.replace(/\/+$/, ""),
       providerId: "custom-openai-compatible",
       providerLabel: OPENAI_COMPATIBLE_PROVIDER_LABELS["custom-openai-compatible"],
       transportId: "dedicated-openai-compatible",
       transportLabel: "专用 OpenAI 兼容接口",
       hostSource: "custom",
       hostSourceConst: "CUSTOM",
       routeMode: "custom",
       supportsModelFetch: true,
       statusStrategies: ["custom", "openai-reverse-proxy"],
       isKnownProvider: false,
       isOpenAiCompatible: true,
     });
   }

   const normalizedUrl = normalizeParsedUrlString(parsedUrl);
   const hostname = String(parsedUrl.hostname || "").trim().toLowerCase();

   if (hostname.includes("anthropic.com")) {
     const apiUrl = stripAnthropicEndpointSuffix(normalizedUrl) || normalizedUrl;
     return createResolvedDedicatedProviderConfig({
       inputUrl: normalizedInput,
       apiUrl,
       providerId: "anthropic-claude",
       providerLabel: "Anthropic Claude",
       transportId: "dedicated-anthropic-claude",
       transportLabel: "Anthropic Claude 接口",
       hostSource: "claude",
       hostSourceConst: "CLAUDE",
       routeMode: "reverse-proxy",
       supportsModelFetch: false,
       statusStrategies: [],
       isKnownProvider: true,
       isOpenAiCompatible: false,
     });
   }

   if (hostname.includes("generativelanguage.googleapis.com")) {
     const apiUrl = stripGoogleAiStudioEndpointSuffix(normalizedUrl) || normalizedUrl;
     return createResolvedDedicatedProviderConfig({
       inputUrl: normalizedInput,
       apiUrl,
       providerId: "google-ai-studio",
       providerLabel: "Google AI Studio / Gemini",
       transportId: "dedicated-google-ai-studio",
       transportLabel: "Google AI Studio / Gemini 接口",
       hostSource: "makersuite",
       hostSourceConst: "MAKERSUITE",
       routeMode: "reverse-proxy",
       supportsModelFetch: true,
       statusStrategies: ["makersuite-reverse-proxy"],
       isKnownProvider: true,
       isOpenAiCompatible: false,
     });
   }

   const providerId = resolveKnownOpenAiCompatibleProviderId(parsedUrl);
   const apiUrl = stripOpenAiCompatibleEndpointSuffix(normalizedUrl) || normalizedUrl;
   return createResolvedDedicatedProviderConfig({
     inputUrl: normalizedInput,
     apiUrl,
     providerId,
     providerLabel:
       OPENAI_COMPATIBLE_PROVIDER_LABELS[providerId] ||
       OPENAI_COMPATIBLE_PROVIDER_LABELS["custom-openai-compatible"],
     transportId: "dedicated-openai-compatible",
     transportLabel: "专用 OpenAI 兼容接口",
     hostSource: "custom",
     hostSourceConst: "CUSTOM",
     routeMode: "custom",
     supportsModelFetch: true,
     statusStrategies: ["custom", "openai-reverse-proxy"],
     isKnownProvider: providerId !== "custom-openai-compatible",
     isOpenAiCompatible: true,
   });
 }

export function createLlmConfigSnapshot(source = {}) {
  return {
    llmApiUrl: normalizeLlmConfigValue(source?.llmApiUrl),
    llmApiKey: normalizeLlmConfigValue(source?.llmApiKey),
    llmModel: normalizeLlmConfigValue(source?.llmModel),
  };
}

export function isUsableLlmConfigSnapshot(snapshot = {}) {
  const normalized = createLlmConfigSnapshot(snapshot);
  return Boolean(normalized.llmApiUrl && normalized.llmModel);
}

export function isSameLlmConfigSnapshot(left = {}, right = {}) {
  const normalizedLeft = createLlmConfigSnapshot(left);
  const normalizedRight = createLlmConfigSnapshot(right);
  return (
    normalizedLeft.llmApiUrl === normalizedRight.llmApiUrl &&
    normalizedLeft.llmApiKey === normalizedRight.llmApiKey &&
    normalizedLeft.llmModel === normalizedRight.llmModel
  );
}

export function normalizeLlmPresetMap(rawPresets = {}) {
  const normalizedPresets = {};
  let changed =
    !rawPresets ||
    typeof rawPresets !== "object" ||
    Array.isArray(rawPresets);

  if (!changed) {
    for (const [name, preset] of Object.entries(rawPresets)) {
      const normalizedName = String(name || "").trim();
      if (!normalizedName) {
        changed = true;
        continue;
      }
      if (
        !preset ||
        typeof preset !== "object" ||
        Array.isArray(preset) ||
        typeof preset.llmApiUrl !== "string" ||
        typeof preset.llmApiKey !== "string" ||
        typeof preset.llmModel !== "string"
      ) {
        changed = true;
        continue;
      }
      normalizedPresets[normalizedName] = {
        llmApiUrl: normalizeLlmConfigValue(preset.llmApiUrl),
        llmApiKey: normalizeLlmConfigValue(preset.llmApiKey),
        llmModel: normalizeLlmConfigValue(preset.llmModel),
      };
      if (normalizedName !== name) {
        changed = true;
      }
    }
  }

  return {
    presets: normalizedPresets,
    changed,
  };
}

export function sanitizeLlmPresetSettings(settings = {}) {
  const normalized = settings && typeof settings === "object" ? settings : {};
  const { presets, changed: presetChanged } = normalizeLlmPresetMap(
    normalized.llmPresets,
  );
  let activePreset =
    typeof normalized.llmActivePreset === "string"
      ? normalized.llmActivePreset
      : "";
  let changed = presetChanged || typeof normalized.llmActivePreset !== "string";

  if (
    activePreset &&
    !Object.prototype.hasOwnProperty.call(presets, activePreset)
  ) {
    activePreset = "";
    changed = true;
  }

  return {
    presets,
    activePreset,
    changed,
  };
}

export function resolveActiveLlmPresetName(settings = {}) {
  const normalized = settings && typeof settings === "object" ? settings : {};
  const { presets, activePreset } = sanitizeLlmPresetSettings(normalized);
  const snapshot = createLlmConfigSnapshot(normalized);

  if (
    activePreset &&
    presets[activePreset] &&
    isSameLlmConfigSnapshot(snapshot, presets[activePreset])
  ) {
    return activePreset;
  }

  const matchingPresets = Object.keys(presets).filter((name) =>
    isSameLlmConfigSnapshot(snapshot, presets[name]),
  );

  if (matchingPresets.length === 1) {
    return matchingPresets[0];
  }

  return "";
}

export function resolveLlmConfigSelection(settings = {}, selectedPresetName = "") {
  const normalized = settings && typeof settings === "object" ? settings : {};
  const { presets } = sanitizeLlmPresetSettings(normalized);
  const globalConfig = createLlmConfigSnapshot(normalized);
  const requestedPresetName = normalizeLlmConfigValue(selectedPresetName);

  if (!requestedPresetName) {
    return {
      source: "global",
      config: globalConfig,
      requestedPresetName: "",
      presetName: "",
      fallbackReason: "",
    };
  }

  const presetConfig = presets[requestedPresetName];
  if (!presetConfig) {
    return {
      source: "global-fallback-missing-task-preset",
      config: globalConfig,
      requestedPresetName,
      presetName: "",
      fallbackReason: "selected_task_preset_missing",
    };
  }

  const normalizedPresetConfig = createLlmConfigSnapshot(presetConfig);
  if (!isUsableLlmConfigSnapshot(normalizedPresetConfig)) {
    return {
      source: "global-fallback-invalid-task-preset",
      config: globalConfig,
      requestedPresetName,
      presetName: "",
      fallbackReason: "selected_task_preset_incomplete",
    };
  }

  return {
    source: "task-preset",
    config: normalizedPresetConfig,
    requestedPresetName,
    presetName: requestedPresetName,
    fallbackReason: "",
  };
}
