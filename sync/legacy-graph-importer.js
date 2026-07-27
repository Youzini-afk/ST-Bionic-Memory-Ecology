function skipped(reason, chatId = "") {
  return { migrated: false, reason, chatId };
}

export async function runLegacyGraphImportOnce({
  chatId = "",
  importOpfs,
  importIndexedDb,
  importMetadata,
} = {}) {
  const opfsResult = await importOpfs();
  if (opfsResult?.migrated) {
    return {
      opfsResult,
      indexedDbResult: skipped("opfs-migration-already-applied", chatId),
      result: opfsResult,
    };
  }

  const indexedDbResult = await importIndexedDb();
  if (
    indexedDbResult?.migrated ||
    indexedDbResult?.reason === "migration-local-store-failed"
  ) {
    return { opfsResult, indexedDbResult, result: indexedDbResult };
  }

  return {
    opfsResult,
    indexedDbResult,
    result: await importMetadata(),
  };
}
