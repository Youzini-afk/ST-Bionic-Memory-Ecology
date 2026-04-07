function normalizeLlmConfigValue(value) {
  return String(value || "").trim();
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
