import { readGlobalHostContext } from "./st-runtime.js";
import { captureHostTransactionContext } from "../runtime/host-transaction-context.js";

function readAuthorityHostBridge() {
  const bridge = globalThis.STAuthorityHostBridge;
  return bridge && typeof bridge === "object" ? bridge : null;
}

export function captureCurrentHostTransactionContext(options = {}) {
  const source = options && typeof options === "object" ? options : {};
  const context = Object.prototype.hasOwnProperty.call(source, "context")
    ? source.context
    : readGlobalHostContext();
  const bridge = Object.prototype.hasOwnProperty.call(source, "bridge")
    ? source.bridge
    : readAuthorityHostBridge();
  return captureHostTransactionContext({ context, bridge });
}
