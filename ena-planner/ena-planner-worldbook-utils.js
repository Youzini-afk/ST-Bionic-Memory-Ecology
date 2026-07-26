function normalizeName(value) {
  return String(value || '').trim();
}

export function normalizeWorldbookNameList(value) {
  const names = [];
  const push = (candidate) => {
    const name = normalizeName(candidate);
    if (name && !names.includes(name)) names.push(name);
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const name of normalizeWorldbookNameList(item)) push(name);
    }
    return names;
  }

  if (typeof value === 'string') {
    push(value);
    return names;
  }

  if (value && typeof value === 'object') {
    push(value.primary);
    if (Array.isArray(value.additional)) value.additional.forEach(push);
    if (Array.isArray(value.names)) value.names.forEach(push);
    if (Array.isArray(value.worldbooks)) value.worldbooks.forEach(push);
    if (Array.isArray(value.globalSelect)) value.globalSelect.forEach(push);
  }

  return names;
}

export async function collectPlannerGlobalWorldbookNames({
  context = null,
  tavernHelper = null,
  worldInfoModule = null,
  windowLike = null,
} = {}) {
  const sources = [];
  const maybePushSource = async (label, getter) => {
    try {
      const value = typeof getter === 'function' ? await getter() : getter;
      const names = normalizeWorldbookNameList(value);
      if (names.length) sources.push({ label, names });
    } catch {
      // ignore compatibility probes
    }
  };

  await maybePushSource(
    'TavernHelper.getGlobalWorldbookNames',
    () => tavernHelper?.getGlobalWorldbookNames?.(),
  );
  await maybePushSource(
    'TavernHelper.getLorebookSettings.selected_global_lorebooks',
    async () => (await tavernHelper?.getLorebookSettings?.())?.selected_global_lorebooks,
  );
  await maybePushSource(
    'world-info.selected_world_info',
    () => worldInfoModule?.selected_world_info,
  );
  await maybePushSource(
    'context.world_info.globalSelect',
    () => context?.world_info?.globalSelect,
  );
  await maybePushSource(
    'context.worldInfo.globalSelect',
    () => context?.worldInfo?.globalSelect,
  );
  await maybePushSource(
    'world-info.world_info.globalSelect',
    () => worldInfoModule?.world_info?.globalSelect,
  );
  await maybePushSource(
    'window.selected_world_info',
    () => windowLike?.selected_world_info,
  );

  const names = [];
  for (const source of sources) {
    for (const name of source.names) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

export async function collectPlannerCharacterWorldbookNames({
  context = null,
  character = null,
  tavernHelper = null,
  windowLike = null,
} = {}) {
  const names = [];
  const push = (candidate) => {
    for (const name of normalizeWorldbookNameList(candidate)) {
      if (!names.includes(name)) names.push(name);
    }
  };

  try {
    push(await tavernHelper?.getCharWorldbookNames?.('current'));
  } catch {
    // ignore compatibility probes
  }
  try {
    push(await tavernHelper?.getCharLorebooks?.({ type: 'all' }));
  } catch {
    // ignore compatibility probes
  }

  push(character?.data?.extensions?.world);
  push(character?.world);
  push(character?.data?.character_book?.name);

  try {
    const cid = context?.characterId ?? context?.this_chid;
    const chars = context?.characters ?? windowLike?.characters;
    const current = chars && cid != null ? chars[cid] : null;
    push(current?.data?.extensions?.world);
    push(current?.world);
    push(current?.data?.character_book?.name);
  } catch {
    // ignore compatibility probes
  }

  push(context?.worldNames);
  try {
    const chat = context?.chat ?? [];
    if (chat.length > 0) push(chat[0]?.extra?.world);
  } catch {
    // ignore compatibility probes
  }

  return names;
}

export function normalizePlannerWorldbookEntries(worldName, data) {
  let entries = Array.isArray(data) ? data : data?.entries;
  if (!entries) return [];
  if (!Array.isArray(entries) && typeof entries === 'object') {
    entries = Object.entries(entries).map(([uid, entry]) => ({
      uid: entry?.uid ?? Number(uid),
      ...entry,
    }));
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(Boolean)
    .map((entry) => ({
      ...entry,
      _worldName: entry?._worldName || entry?.world || worldName,
    }));
}

export function isPlannerWorldbookEntryEnabled(entry = {}) {
  return !entry?.disable && !entry?.disabled && entry?.enabled !== false;
}

export function isPlannerWorldbookEntryConstant(entry = {}) {
  return entry?.constant === true || entry?.type === 'constant';
}
