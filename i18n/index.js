const CATALOGS = Object.freeze({
  zh: Object.freeze({
    "graph.scope.characterPov": "角色 POV · {name}",
    "graph.scope.objective": "客观层",
    "graph.scope.unknownCharacter": "未知角色",
    "graph.scope.userPov": "用户 POV",
  }),
  en: Object.freeze({
    "graph.scope.characterPov": "Character POV · {name}",
    "graph.scope.objective": "Objective Layer",
    "graph.scope.unknownCharacter": "Unknown character",
    "graph.scope.userPov": "User POV",
  }),
});

function interpolate(template, params) {
  return template.replace(/\{([A-Za-z_][\w.-]*)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name] ?? "")
      : match,
  );
}

export function t(key, params = {}, options = {}) {
  const language = String(globalThis.navigator?.language || "zh").toLowerCase();
  const catalog = language.startsWith("en") ? CATALOGS.en : CATALOGS.zh;
  const template = catalog[key] ?? CATALOGS.zh[key];
  return template == null
    ? String(options.fallback ?? key)
    : interpolate(template, params);
}
