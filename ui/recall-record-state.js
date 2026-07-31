export function resolveRecallRecordState(record = null) {
  const injectionText = String(record?.injectionText || "").trim();
  const completed = record?.completed === true;
  const empty = completed && record?.empty === true && !injectionText;
  const ready = Boolean(injectionText);
  return {
    present: Boolean(record && (ready || empty)),
    completed,
    empty,
    ready,
  };
}
