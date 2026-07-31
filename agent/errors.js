export class BmeAgentError extends Error {
  constructor(message, { code = "bme_agent_error", details = {}, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BmeAgentError";
    this.code = code;
    this.details = details && typeof details === "object" ? details : {};
  }
}

export class BmeAgentProtocolError extends BmeAgentError {
  constructor(message, details = {}) {
    super(message, { code: "bme_agent_protocol", details });
    this.name = "BmeAgentProtocolError";
  }
}

export class BmeAgentGuardError extends BmeAgentError {
  constructor(message, details = {}) {
    super(message, { code: "bme_agent_guard", details });
    this.name = "BmeAgentGuardError";
  }
}

export class BmeAgentSuspendedError extends BmeAgentError {
  constructor(message, details = {}, cause = undefined) {
    super(message, { code: "bme_agent_suspended", details, cause });
    this.name = "BmeAgentSuspendedError";
  }
}

export class BmeAgentCancelledError extends BmeAgentError {
  constructor(message = "BME Agent run was cancelled", details = {}) {
    super(message, { code: "bme_agent_cancelled", details });
    this.name = "BmeAgentCancelledError";
  }
}

export class BmeAgentContextError extends BmeAgentError {
  constructor(message, details = {}) {
    super(message, { code: "bme_agent_context", details });
    this.name = "BmeAgentContextError";
  }
}

export function isAbortLikeError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    error?.code === "bme_agent_cancelled"
  );
}
