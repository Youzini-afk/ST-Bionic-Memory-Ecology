function normalizeKeyForAlias(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeAliasMatchKey(value) {
  let text = String(value ?? "");
  if (typeof text.normalize === "function") {
    try {
      text = text.normalize("NFKC");
    } catch {
      // ignore invalid normalization environments
    }
  }
  text = text.trim().toLowerCase();
  text = text.replace(
    /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u00b7\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2000-\u206f\u2e00-\u2e7f]+/g,
    " ",
  );
  return text.replace(/\s+/g, " ").trim();
}

export function collectAliasMatchVariants(raw) {
  const variants = [];
  const legacy = normalizeKeyForAlias(raw);
  if (legacy) variants.push(legacy);
  const soft = normalizeAliasMatchKey(raw);
  if (soft) {
    variants.push(soft);
    const compact = soft.replace(/\s/g, "");
    if (compact && compact !== soft) {
      variants.push(compact);
    }
  }
  return [...new Set(variants.filter(Boolean))];
}

export function addAliasMatchVariantsToSet(target, raw) {
  if (!(target instanceof Set)) return target;
  for (const variant of collectAliasMatchVariants(raw)) {
    target.add(variant);
  }
  return target;
}

function ingestAliasHints(target, hints) {
  if (hints == null) return;
  if (typeof hints === "string") {
    addAliasMatchVariantsToSet(target, hints);
    return;
  }
  if (Array.isArray(hints)) {
    for (const item of hints) {
      ingestAliasHints(target, item);
    }
    return;
  }
  if (typeof hints === "object") {
    addAliasMatchVariantsToSet(target, hints.name1);
    addAliasMatchVariantsToSet(target, hints.userName);
    addAliasMatchVariantsToSet(target, hints.personaName);
    addAliasMatchVariantsToSet(target, hints.name);
    if (Array.isArray(hints.aliases)) {
      for (const alias of hints.aliases) {
        addAliasMatchVariantsToSet(target, alias);
      }
    }
  }
}

export function buildUserPovAliasNormalizedSet(hints) {
  const aliasSet = new Set();
  ingestAliasHints(aliasSet, hints);
  return aliasSet;
}

export function aliasSetMatchesValue(aliasSet, value) {
  if (!(aliasSet instanceof Set) || aliasSet.size === 0) return false;
  for (const variant of collectAliasMatchVariants(value)) {
    if (aliasSet.has(variant)) {
      return true;
    }
  }
  return false;
}

function safeReadHostContext() {
  const candidates = [
    globalThis.SillyTavern?.getContext?.(),
    globalThis.getContext?.(),
    globalThis.__stBmeTestContext,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate;
    }
  }
  return null;
}

function pushAliasHint(target, value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || target.includes(normalized)) return;
  target.push(normalized);
}

export function getHostUserAliasHints(extraHints = null) {
  const hints = [];
  const context = safeReadHostContext();
  pushAliasHint(hints, context?.name1);
  pushAliasHint(hints, context?.user?.name);
  pushAliasHint(hints, context?.userName);
  pushAliasHint(hints, context?.prompt?.userName);

  const ingest = (value) => {
    if (value == null) return;
    if (typeof value === "string") {
      pushAliasHint(hints, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) ingest(item);
      return;
    }
    if (typeof value === "object") {
      pushAliasHint(hints, value.name1);
      pushAliasHint(hints, value.userName);
      pushAliasHint(hints, value.personaName);
      pushAliasHint(hints, value.name);
      if (Array.isArray(value.aliases)) {
        for (const alias of value.aliases) ingest(alias);
      }
    }
  };

  ingest(extraHints);
  return hints;
}
