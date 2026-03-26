export function resolveConfiguredTimeoutMs(
  settings = {},
  fallbackMs = 300000,
) {
  const timeoutMs = Number(settings?.timeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : fallbackMs;
}
