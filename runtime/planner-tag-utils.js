const DEFAULT_PLANNER_TAGS = ["plot", "note", "plot-log", "state"];

export function stripPlannerTags(text, tags = DEFAULT_PLANNER_TAGS) {
  let output = String(text ?? "");

  for (const rawTag of Array.isArray(tags) ? tags : DEFAULT_PLANNER_TAGS) {
    const tag = String(rawTag || "").trim().toLowerCase();
    if (!tag) continue;
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(
      new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi"),
      "",
    );
  }

  return output.trim();
}

export function sanitizePlannerMessageText(message, tags = DEFAULT_PLANNER_TAGS) {
  if (!message) return "";
  const text = String(message.mes ?? "");
  return message.is_user ? stripPlannerTags(text, tags) : text;
}

export { DEFAULT_PLANNER_TAGS };
