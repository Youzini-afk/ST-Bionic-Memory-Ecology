import {
  HOST_ADAPTER_VERSION,
  buildCapabilityCollectionSnapshot,
  buildCapabilityStatus,
  mergeVersionHints,
} from "./capabilities.js";
import { createContextHostFacade } from "./context.js";
import { createInjectionHostFacade } from "./injection.js";
import { createRegexHostFacade } from "./regex.js";
import { createWorldbookHostFacade } from "./worldbook.js";

export const HOST_ADAPTER_STATE_SEMANTICS =
  "manual-refresh-diagnostic-snapshot";
export const HOST_ADAPTER_REFRESH_MODE = "manual-rebuild";

let currentHostAdapter = null;
let currentHostAdapterOptions = {};
let currentHostAdapterRevision = 0;

function createSnapshotMetadata(options = {}) {
  const snapshotRevision = Number.isSafeInteger(options.snapshotRevision)
    ? options.snapshotRevision
    : 0;
  const snapshotCreatedAt =
    typeof options.snapshotCreatedAt === "string" && options.snapshotCreatedAt
      ? options.snapshotCreatedAt
      : new Date().toISOString();

  return Object.freeze({
    stateSemantics: String(
      options.stateSemantics || HOST_ADAPTER_STATE_SEMANTICS,
    ),
    refreshMode: String(options.refreshMode || HOST_ADAPTER_REFRESH_MODE),
    snapshotRevision,
    snapshotCreatedAt,
  });
}

function buildManagedCreateOptions(options = {}) {
  currentHostAdapterRevision += 1;

  return {
    ...options,
    stateSemantics: HOST_ADAPTER_STATE_SEMANTICS,
    refreshMode: HOST_ADAPTER_REFRESH_MODE,
    snapshotRevision: currentHostAdapterRevision,
    snapshotCreatedAt: new Date().toISOString(),
  };
}

function buildHostCapabilitySnapshot(
  adapter,
  options = {},
  snapshotMetadata = createSnapshotMetadata(options),
) {
  const snapshot = buildCapabilityCollectionSnapshot(
    {
      context: buildCapabilityStatus(adapter.context),
      worldbook: buildCapabilityStatus(adapter.worldbook),
      regex: buildCapabilityStatus(adapter.regex),
      injection: buildCapabilityStatus(adapter.injection),
    },
    {
      versionHints: mergeVersionHints(
        {
          adapter: HOST_ADAPTER_VERSION,
          scope: "st-bme-host-adapter",
          stateSemantics: snapshotMetadata.stateSemantics,
          refreshMode: snapshotMetadata.refreshMode,
          snapshotRevision: String(snapshotMetadata.snapshotRevision),
          snapshotCreatedAt: snapshotMetadata.snapshotCreatedAt,
        },
        options.versionHints,
      ),
    },
  );

  return Object.freeze({
    ...snapshot,
    stateSemantics: snapshotMetadata.stateSemantics,
    refreshMode: snapshotMetadata.refreshMode,
    snapshotRevision: snapshotMetadata.snapshotRevision,
    snapshotCreatedAt: snapshotMetadata.snapshotCreatedAt,
  });
}

export function createHostAdapter(options = {}) {
  const context = createContextHostFacade(options);
  const sharedOptions = {
    ...options,
    contextHost: context,
  };
  const worldbook = createWorldbookHostFacade(sharedOptions);
  const regex = createRegexHostFacade(sharedOptions);
  const injection = createInjectionHostFacade(sharedOptions);
  const adapter = {
    context,
    worldbook,
    regex,
    injection,
  };
  const snapshotMetadata = createSnapshotMetadata(sharedOptions);
  const snapshot = buildHostCapabilitySnapshot(
    adapter,
    sharedOptions,
    snapshotMetadata,
  );

  return Object.freeze({
    ...snapshot,
    ...adapter,
    getSnapshot() {
      return snapshot;
    },
    readStateMetadata() {
      return snapshotMetadata;
    },
    refresh(options = {}) {
      return refreshHostAdapter(options);
    },
  });
}

export function initializeHostAdapter(options = {}) {
  currentHostAdapterOptions = { ...options };
  currentHostAdapter = createHostAdapter(
    buildManagedCreateOptions(currentHostAdapterOptions),
  );
  return currentHostAdapter;
}

export function refreshHostAdapter(options = {}) {
  currentHostAdapterOptions = {
    ...currentHostAdapterOptions,
    ...options,
  };
  currentHostAdapter = createHostAdapter(
    buildManagedCreateOptions(currentHostAdapterOptions),
  );
  return currentHostAdapter;
}

export function getHostAdapter() {
  if (!currentHostAdapter) {
    currentHostAdapter = createHostAdapter(
      buildManagedCreateOptions(currentHostAdapterOptions),
    );
  }
  return currentHostAdapter;
}

export function getHostCapabilitySnapshot() {
  return getHostAdapter().getSnapshot();
}

export function refreshHostCapabilitySnapshot(options = {}) {
  return refreshHostAdapter(options).getSnapshot();
}

export function readHostCapability(name, options = {}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    return null;
  }

  const refreshOptions =
    options && typeof options === "object" ? { ...options } : {};
  const shouldRefresh = refreshOptions.refresh === true;
  delete refreshOptions.refresh;

  const snapshot = shouldRefresh
    ? refreshHostCapabilitySnapshot(refreshOptions)
    : getHostCapabilitySnapshot();

  return snapshot?.[normalizedName] || null;
}
