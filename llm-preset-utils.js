function normalizeLlmConfigValue(value) {
  return String(value || "").trim();
}

export function isSameLlmConfigSnapshot(left = {}, right = {}) {
  return (
    normalizeLlmConfigValue(left?.llmApiUrl) ===
      normalizeLlmConfigValue(right?.llmApiUrl) &&
    normalizeLlmConfigValue(left?.llmApiKey) ===
      normalizeLlmConfigValue(right?.llmApiKey) &&
    normalizeLlmConfigValue(left?.llmModel) ===
      normalizeLlmConfigValue(right?.llmModel)
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
  const snapshot = {
    llmApiUrl: normalizeLlmConfigValue(normalized.llmApiUrl),
    llmApiKey: normalizeLlmConfigValue(normalized.llmApiKey),
    llmModel: normalizeLlmConfigValue(normalized.llmModel),
  };

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
