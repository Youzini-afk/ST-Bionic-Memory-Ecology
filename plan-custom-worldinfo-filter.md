# Plan: 世界书自定义过滤模式（v4）

## 需求

- **默认模式**：保持现有全部行为不变
- **自定义模式**：完全替代 MVU 过滤链路：
  1. disabled 条目不进入读取链路
  2. 条目 `name`（仅 name）包含用户指定关键词的条目被跳过
  3. 不做任何 MVU heuristic / sanitize / blockedContents 处理
  - 关键词留空 → 除 disabled 外全部可读

## 行为护栏

- 这次改动的目标只是给世界书读取新增一条 **custom 跑道**，不是重写默认逻辑
- `worldInfoFilterMode !== "custom"` 时，行为必须与当前版本逐字节等价：
  - 仍走 `getMvuIgnoreReason()`
  - 仍写入 `blockedContents`
  - 仍保留默认模式下 disabled 条目可被 EJS `getwi` 读取的现有语义
  - 仍保持现有 `debug.mvu`、缓存、warning 文案和 prompt-builder 清洗行为
- 只有在 `worldInfoFilterMode === "custom"` 时，才切到自定义分支
- 任何实现如果让默认模式下“本来能读到的条目读不到”，都视为回归

---

## 需要切断的 MVU 链路（自定义模式下全部跳过）

| # | 位置 | 作用 | 自定义模式处理 |
|---|------|------|---------------|
| A | `task-worldinfo.js` L779 `getMvuIgnoreReason()` | 按 name/comment 标签 + 内容特征过滤条目 | 替换为自定义关键词按 `entry.name` 过滤 |
| B | `task-worldinfo.js` L781 `registerIgnoredWorldInfoEntry()` | 被过滤条目 content 推入 `blockedContents` | 自定义过滤条目不推入 `blockedContents` |
| C | `task-worldinfo.js` L1387 `sanitizeMvuContent()` | 渲染后条目再过一轮 MVU 内容检测 | 跳过，直接使用渲染结果 |
| D | `task-worldinfo.js` L1190 `__mvuBlockedContents` | 传递给 prompt-builder | 自定义模式下为空数组 |
| E | `prompt-builder.js` L700 `runtimeBlockedContents` | 读取 `__mvuBlockedContents` 对条目做内容删除 | 空数组 → 不删除 |
| F | `prompt-builder.js` L651,733 `sanitizeTaskPromptText()` | 默认 `applyMvu: true`，对世界书条目和 additionalMessages 跑 `sanitizeMvuContent()` | 传 `applyMvu: false` |
| G | `prompt-builder.js` L1137 `sanitizeTaskPromptText()` | 最终 block 组装阶段还会再跑一次 MVU 清洗 | 自定义模式下，对世界书来源 block 传 `applyMvu: false` |
| H | `prompt-builder.js` L1445 `sanitizePromptMessages()` | fallback 路径会再次清洗 `privateTaskMessages` | 自定义模式下，对世界书来源 message 传 `applyMvu: false` |
| I | `task-ejs.js` L564-568 `resolveIgnoredEntry` 回调 | 被过滤条目 warning 文案硬编码为 `"mvu filtered world info blocked"` | 自定义过滤条目不走这条 warning |
| J | `task-worldinfo.js` L159 `buildMvuDebugSummary()` | 把 mvuCollector 数据归入 `debug.mvu` | 自定义过滤条目归入独立的 `debug.customFilter`，不混入 `debug.mvu` |

---

## 涉及文件与改动

### 1. `index.js` — 新增默认设置字段（~L378 `defaultSettings`）

```js
worldInfoFilterMode: "default",        // "default" | "custom"
worldInfoFilterCustomKeywords: "",     // 逗号分隔，如 "BME,测试"
```

### 2. `panel.html` — 功能开关页新增卡片

在 `data-config-section="toggles"` 的 `bme-config-grid` 中，增强能力卡片（L1015 `</div>`）之后、隐藏旧楼层卡片（L1017）之前，插入：

```html
<div class="bme-config-card">
  <div class="bme-config-card-head">
    <div>
      <div class="bme-config-card-title">世界书过滤</div>
      <div class="bme-config-card-subtitle">
        控制 ST-BME 读取世界书条目时的过滤策略。默认自动过滤 MVU 相关条目；自定义模式仅按条目名称关键词过滤。
      </div>
    </div>
  </div>
  <div class="bme-config-row">
    <label for="bme-setting-wi-filter-mode">过滤模式</label>
    <select id="bme-setting-wi-filter-mode" class="bme-config-input">
      <option value="default">默认（自动过滤 MVU 条目）</option>
      <option value="custom">自定义（按名称关键词过滤）</option>
    </select>
  </div>
  <div id="bme-wi-filter-custom-section" style="display:none;">
    <div class="bme-config-row">
      <label for="bme-setting-wi-filter-keywords">过滤关键词</label>
      <input
        id="bme-setting-wi-filter-keywords"
        class="bme-config-input"
        type="text"
        placeholder="用逗号分隔，如：BME,mvu,测试"
      />
    </div>
    <div class="bme-config-help">
      条目名称中包含任一关键词即跳过（不区分大小写）。留空则不过滤任何条目（仅跳过已禁用的条目）。
    </div>
  </div>
</div>
```

### 3. `panel.js` — 绑定 UI 与设置

**`_refreshConfigTab`（L1848）** 中追加：

```js
_setInputValue("bme-setting-wi-filter-mode", settings.worldInfoFilterMode || "default");
_setInputValue("bme-setting-wi-filter-keywords", settings.worldInfoFilterCustomKeywords || "");
const wiFilterCustomSection = panelEl?.querySelector("#bme-wi-filter-custom-section");
if (wiFilterCustomSection) {
  wiFilterCustomSection.style.display =
    (settings.worldInfoFilterMode || "default") === "custom" ? "" : "none";
}
```

**事件绑定区域（~L2318 附近，`noticeDisplayModeEl` 绑定之后）** 追加：

```js
const wiFilterModeEl = document.getElementById("bme-setting-wi-filter-mode");
if (wiFilterModeEl && wiFilterModeEl.dataset.bmeBound !== "true") {
  wiFilterModeEl.addEventListener("change", () => {
    _patchSettings({ worldInfoFilterMode: wiFilterModeEl.value || "default" });
    const section = panelEl?.querySelector("#bme-wi-filter-custom-section");
    if (section) {
      section.style.display = wiFilterModeEl.value === "custom" ? "" : "none";
    }
  });
  wiFilterModeEl.dataset.bmeBound = "true";
}
const wiFilterKeywordsEl = document.getElementById("bme-setting-wi-filter-keywords");
if (wiFilterKeywordsEl && wiFilterKeywordsEl.dataset.bmeBound !== "true") {
  wiFilterKeywordsEl.addEventListener("change", () => {
    _patchSettings({ worldInfoFilterCustomKeywords: wiFilterKeywordsEl.value || "" });
  });
  wiFilterKeywordsEl.dataset.bmeBound = "true";
}
```

### 4. `task-worldinfo.js` — 核心过滤逻辑

#### 4a. 新增独立的自定义过滤 collector（不复用 mvuCollector）

```js
function createCustomFilterCollector() {
  return {
    filteredEntries: [],
    lazyFilteredEntries: [],
  };
}

function registerCustomFilteredEntry(collector, entry, matchedKeyword, { lazy = false } = {}) {
  if (!collector || !entry) return;
  const meta = {
    worldbook: normalizeKey(entry.worldbook),
    name: entry.name,
    matchedKeyword,
    reason: "custom_keyword",
  };
  if (lazy) {
    collector.lazyFilteredEntries.push(meta);
  } else {
    collector.filteredEntries.push(meta);
  }
}

function buildCustomFilterDebugSummary(collector, {
  filterMode = "default",
  customFilterKeywords = [],
} = {}) {
  const filteredEntries = Array.isArray(collector?.filteredEntries)
    ? collector.filteredEntries
    : [];
  const lazyFilteredEntries = Array.isArray(collector?.lazyFilteredEntries)
    ? collector.lazyFilteredEntries
    : [];

  return {
    mode: filterMode,
    keywords: [...customFilterKeywords],
    filteredEntryCount: filteredEntries.length + lazyFilteredEntries.length,
    filteredEntries: [...filteredEntries, ...lazyFilteredEntries],
    lazyFilteredEntryCount: lazyFilteredEntries.length,
  };
}
```

不推入 `blockedContents`，不注册进 `ignoredLookup`。

#### 4b. `resolveTaskWorldInfo` 入口（L1128）解析设置并透传

```js
const filterMode = String(settings.worldInfoFilterMode || "default").trim();
const isCustomFilter = filterMode === "custom";
const customFilterKeywords = isCustomFilter
  ? String(settings.worldInfoFilterCustomKeywords || "")
      .split(",")
      .map(kw => kw.trim().toLowerCase())
      .filter(Boolean)
  : [];
```

传给 `collectAllWorldbookEntries`：`{ filterMode, customFilterKeywords }`

同时给 `result.debug` 预留默认结构，避免无世界书命中时 `debug.customFilter` 缺失：

```js
result.debug.customFilter = {
  mode: filterMode,
  keywords: customFilterKeywords,
  filteredEntryCount: 0,
  filteredEntries: [],
  lazyFilteredEntryCount: 0,
};
```

#### 4c. `collectAllWorldbookEntries`（L792）透传

函数签名增加 `{ filterMode = "default", customFilterKeywords = [] } = {}`。

- 创建 `const customFilterCollector = createCustomFilterCollector();`
- `loadWorldbookOnce` 调用 `loadNormalizedWorldbookEntries` 时传入 `{ mvuCollector, filterMode, customFilterKeywords, customFilterCollector }`
- 缓存 key 中加入 `filterMode` 和 `customFilterKeywords`

```js
const cacheKey = JSON.stringify({
  // ... 现有字段 ...
  filterMode,
  customFilterKeywords,
});
```

- `debug` 和缓存对象都带上 `customFilter`

```js
const customFilterDebug = buildCustomFilterDebugSummary(customFilterCollector, {
  filterMode,
  customFilterKeywords,
});

worldbookEntriesCache = {
  // ...现有字段...
  debug: {
    ...debug,
    mvu: buildMvuDebugSummary(mvuCollector),
    customFilter: customFilterDebug,
  },
};

return {
  entries: allEntries,
  blockedContents: [...mvuCollector.blockedContents],
  ignoredEntries: [...debug.mvu.filteredEntries],
  ignoredLookup: new Map(mvuCollector.ignoredLookup),
  debug: {
    ...debug,
    mvu: buildMvuDebugSummary(mvuCollector),
    customFilter: customFilterDebug,
  },
};
```

缓存命中分支也要把 `worldbookEntriesCache.debug?.customFilter` 原样回传。

#### 4d. `loadNormalizedWorldbookEntries`（L741）—— 核心改造

```js
async function loadNormalizedWorldbookEntries(
  worldbookHost, worldbookName,
  { mvuCollector = null, lazy = false, filterMode = "default",
    customFilterKeywords = [], customFilterCollector = null } = {},
) {
  // ... 现有逻辑读取 entries 和 commentByUid ...

  const normalizedEntries = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalizedEntry = normalizeEntry(/* 不变 */);

    if (filterMode === "custom") {
      // 自定义模式：disabled 条目直接跳过，不进入 allEntries
      if (!normalizedEntry.enabled) continue;

      // 按 entry.name 关键词过滤
      if (customFilterKeywords.length > 0) {
        const nameLower = normalizedEntry.name.toLowerCase();
        const matched = customFilterKeywords.find(kw => nameLower.includes(kw));
        if (matched) {
          registerCustomFilteredEntry(customFilterCollector, normalizedEntry, matched, { lazy });
          continue;
        }
      }
      // 通过 → 加入结果，不做 MVU 检测
    } else {
      // 默认模式：现有 MVU 逻辑，完全不动
      const ignoreReason = getMvuIgnoreReason(normalizedEntry);
      if (ignoreReason) {
        registerIgnoredWorldInfoEntry(mvuCollector, normalizedEntry, ignoreReason, { lazy });
        continue;
      }
    }

    normalizedEntries.push(normalizedEntry);
  }
  return normalizedEntries;
}
```

**关于 disabled 条目**：仅自定义模式下在此处跳过。默认模式保持原样（disabled 条目进入 `allEntries`，在 L588 激活阶段跳过，但 EJS `getwi` 仍可按需拉取——这是现有有意设计）。

#### 4e. `resolveTaskWorldInfo` 中渲染后清洗（~L1387）

```js
// 原：
const mvuSanitized = sanitizeMvuContent(renderedContent, {
  mode: "aggressive",
  blockedContents,
});

// 改为：
const mvuSanitized = isCustomFilter
  ? { text: renderedContent, changed: false, dropped: false,
      reasons: [], blockedHitCount: 0, artifactRemovedCount: 0 }
  : sanitizeMvuContent(renderedContent, { mode: "aggressive", blockedContents });
```

#### 4f. `__mvuBlockedContents` 与 `blockedContents`（~L1190）

自定义模式下 `mvuCollector.blockedContents` 本来就不会被填入（因为 4d 不走 `registerIgnoredWorldInfoEntry`），所以 `blockedContents` 自然为空数组。`__mvuBlockedContents` 赋值逻辑不需要改动，空数组传过去 prompt-builder 就不会做任何内容删除。

#### 4g. 懒加载世界书透传（~L1269）

```js
const lazyCustomFilterCollector = createCustomFilterCollector();

const lazyEntries = await loadNormalizedWorldbookEntries(
  worldbookHost, normalizedWorldbook,
  { mvuCollector: lazyMvuCollector, lazy: true,
    filterMode, customFilterKeywords, customFilterCollector: lazyCustomFilterCollector },
);
```

这里改为**仿照现有 `lazyMvuCollector` 模式**，在 `resolveTaskWorldInfo()` 内新建一个局部 `lazyCustomFilterCollector`，原因是：

- `collectAllWorldbookEntries()` 里的 `customFilterCollector` 是其内部局部变量，`resolveTaskWorldInfo()` 闭包里拿不到
- 懒加载发生在 `resolveTaskWorldInfo()` 内部，不在 `collectAllWorldbookEntries()` 的作用域里
- 直接照着现有 `lazyMvuCollector` 的合并写法做，最贴近现有代码结构，风险最低

回调后立刻合并到 `result.debug.customFilter`：

```js
const newLazyEntries = [...lazyCustomFilterCollector.lazyFilteredEntries];
if (newLazyEntries.length > 0) {
  result.debug.customFilter = {
    ...result.debug.customFilter,
    filteredEntries: [
      ...(Array.isArray(result.debug.customFilter?.filteredEntries)
        ? result.debug.customFilter.filteredEntries
        : []),
      ...newLazyEntries,
    ],
    filteredEntryCount:
      Number(result.debug.customFilter?.filteredEntryCount || 0) +
      newLazyEntries.length,
    lazyFilteredEntryCount:
      Number(result.debug.customFilter?.lazyFilteredEntryCount || 0) +
      newLazyEntries.length,
  };
}
lazyCustomFilterCollector.lazyFilteredEntries = [];
```

这和当前 `L1278-L1294` 对 `lazyMvuCollector` 的处理是同构的，语义也最直观：

- 首轮加载的自定义过滤统计来自 `collectAllWorldbookEntries()`
- 懒加载追加过滤统计来自 `lazyCustomFilterCollector`
- 两者最终都汇总到同一个 `result.debug.customFilter`

#### 4h. 调试信息——独立的 `debug.customFilter`

```js
result.debug = {
  ...result.debug,
  ...(collected?.debug || {}),
  customFilter:
    collected?.debug?.customFilter && typeof collected.debug.customFilter === "object"
      ? { ...collected.debug.customFilter }
      : buildCustomFilterDebugSummary(null, { filterMode, customFilterKeywords }),
};
```

不混入 `debug.mvu`。自定义模式下 `debug.mvu` 保持初始空值（`buildMvuDebugSummary(null)` 返回的全零结构），`debug.customFilter` 始终由 `collectAllWorldbookEntries()` 汇总后统一返回。

#### 4i. `resolveIgnoredEntry` 回调与 EJS warning（~L1315）

自定义模式下传给 `createTaskEjsRenderContext` 的 `resolveIgnoredEntry` 改为查自定义 collector：

```js
resolveIgnoredEntry: isCustomFilter
  ? (worldbookName, identifier) => {
      // 自定义过滤条目不注册进 ignoredLookup，所以 EJS getwi 找不到时不会报 MVU warning
      return null;
    }
  : (worldbookName, identifier) =>
      findIgnoredWorldInfoEntry({ ignoredLookup }, worldbookName, identifier),
```

自定义模式下 `getwi` 找不到条目只会走正常的 "target not found" 逻辑（L639），不会出现 "mvu filtered world info blocked" 字样。

### 5. `prompt-builder.js` — 自定义模式下跳过世界书条目的 MVU 清洗

#### 5a. `sanitizeWorldInfoContext`（L682）

已有参数 `settings`，读取 `settings.worldInfoFilterMode`：

```js
const isCustomFilter = String(settings.worldInfoFilterMode || "default").trim() === "custom";
```

传给 `sanitizeWorldInfoEntries` 和 `sanitizeTaskPromptText`：

```js
const beforeEntries = sanitizeWorldInfoEntries(
  settings, taskType, worldInfo?.beforeEntries,
  runtimeBlockedContents, debugState, regexCollector,
  { applyMvu: !isCustomFilter },  // 新增
);
// afterEntries, atDepthEntries 同理
```

additionalMessages 的 `sanitizeTaskPromptText` 调用也传 `applyMvu: !isCustomFilter`。

#### 5b. `sanitizeWorldInfoEntries`（L641）

签名增加 `options = {}` 参数：

```js
function sanitizeWorldInfoEntries(
  settings, taskType, entries, blockedContents,
  debugState, regexCollector,
  { applyMvu = true } = {},
) {
```

内部调用 `sanitizeTaskPromptText` 时透传 `applyMvu`：

```js
const sanitized = sanitizeTaskPromptText(settings, taskType, content, {
  mode: "aggressive",
  blockedContents,
  regexStage: "",
  role: entry?.role || "system",
  regexCollector,
  applyMvu,  // 新增
});
```

#### 5c. `buildTaskPrompt` 最终 block 清洗（L1137）也要跳过世界书来源内容

这是 v3 漏掉的关键点。即使 `resolveTaskWorldInfo()` 和 `sanitizeWorldInfoContext()` 都不做 MVU 清洗，`buildTaskPrompt()` 在把 block 内容组装成最终 `systemPrompt` / `executionMessages` 时，还会再调用一次 `sanitizeTaskPromptText()`。如果不改，这一层仍会把自定义模式下的世界书内容删掉。

新增 helper：

```js
function blockUsesWorldInfoContent(block = {}) {
  const sourceKey = String(block?.sourceKey || "");
  if (
    sourceKey === "worldInfoBefore" ||
    sourceKey === "worldInfoAfter" ||
    sourceKey === "worldInfoBeforeEntries" ||
    sourceKey === "worldInfoAfterEntries" ||
    sourceKey === "worldInfoAtDepthEntries" ||
    sourceKey === "activatedWorldInfoNames" ||
    sourceKey === "taskAdditionalMessages"
  ) {
    return true;
  }

  const content = String(block?.content || "");
  return /\{\{\s*(worldInfoBefore|worldInfoAfter|worldInfoBeforeEntries|worldInfoAfterEntries|worldInfoAtDepthEntries|activatedWorldInfoNames|taskAdditionalMessages)\s*\}\}/.test(content);
}
```

在 `buildTaskPrompt()` 里计算：

```js
const isCustomFilter = String(settings.worldInfoFilterMode || "default").trim() === "custom";
const blockApplyMvu = !(isCustomFilter && blockUsesWorldInfoContent(block));

const sanitizedBlockContent = sanitizeTaskPromptText(settings, taskType, content, {
  mode: "final-safe",
  blockedContents: worldInfoRuntimeBlockedContents,
  regexStage: "",
  role,
  regexCollector: promptRegexInput,
  applyMvu: blockApplyMvu,
});
```

这里**只**对“世界书来源 block”关闭 MVU；其他普通 block 仍保持现有清洗行为，不扩大改动面。

#### 5d. `buildTaskLlmPayload` fallback 路径（L1445）保持同样规则

当 `executionMessages.length === 0` 时，代码会回退到 `privateTaskMessages` 并再次调用 `sanitizePromptMessages()`。这条 fallback 也必须遵守和 5c 一样的规则，否则仍然可能在极端路径里把自定义模式的世界书内容清掉。

这里收敛成**单一路径**，不要再给 message 打额外标记：

1. 给 `sanitizePromptMessages()` 增加 `applyMvu = true` 选项，并向下透传到 `sanitizeStructuredPromptValue()`
2. fallback 调用时直接按模式传参：

```js
const additionalMessages =
  executionMessages.length > 0
    ? []
    : sanitizePromptMessages(
        {},
        taskType,
        Array.isArray(promptBuild?.privateTaskMessages)
          ? promptBuild.privateTaskMessages
          : [],
        {
          blockedContents,
          regexStage: "",
          applyMvu: !isCustomFilter,
        },
      );
```

这样做的理由：

- fallback 本身就是极端兜底路径，没必要再做“按 message 来源细分”的复杂逻辑
- 自定义模式要求“世界书链路不做 MVU sanitize”，fallback 时直接整体关闭 MVU 更符合预期
- 默认模式不受影响，仍保持 `applyMvu: true`

这样可保证：

- 正常路径不会二次清洗世界书内容
- fallback 路径也不会偷偷恢复 MVU 清洗
- 默认模式仍保持原行为

### 6. 测试（`tests/task-worldinfo.mjs`）

#### 6a. 自定义模式替代 MVU——MVU 条目不再被过滤

```js
const customResult = await resolveTaskWorldInfo({
  settings: { worldInfoFilterMode: "custom", worldInfoFilterCustomKeywords: "" },
  userMessage: "继续调查",
  templateContext: { recentMessages: "...", charName: "Alice" },
});
// MVU tagged/heuristic 条目应出现在激活结果中
assert.equal(
  customResult.beforeEntries.some(e => e.sourceName === "[mvu_update] 状态同步"),
  true,
  "custom filter mode should not filter MVU tagged entries",
);
assert.equal(
  customResult.beforeEntries.some(e => e.sourceName === "MVU 启发式条目"),
  true,
  "custom filter mode should not filter MVU heuristic entries",
);
// debug.mvu 应为空
assert.equal(customResult.debug.mvu.filteredEntryCount, 0);
// debug.customFilter 存在且 mode 正确
assert.equal(customResult.debug.customFilter.mode, "custom");
assert.equal(customResult.debug.customFilter.filteredEntryCount, 0);
```

#### 6b. 自定义关键词仅匹配 name

```js
const keywordResult = await resolveTaskWorldInfo({
  settings: { worldInfoFilterMode: "custom", worldInfoFilterCustomKeywords: "常驻" },
  userMessage: "继续调查",
  templateContext: { recentMessages: "...", charName: "Alice" },
});
// name 为 "常驻设定" → 被过滤
assert.equal(
  keywordResult.beforeEntries.some(e => e.sourceName === "常驻设定"),
  false,
);
// comment 包含某关键词但 name 不包含 → 不被过滤（用现有 fixture 验证）
assert.equal(keywordResult.debug.customFilter.filteredEntryCount, 1);
assert.equal(keywordResult.debug.customFilter.filteredEntries[0].name, "常驻设定");
assert.equal(keywordResult.debug.customFilter.filteredEntries[0].matchedKeyword, "常驻");
```

#### 6c. disabled 条目在自定义模式下不可被 getwi 读到

```js
// dynEntry (enabled=false, name="EW/Dyn/线索") 在自定义模式下不应进入 allEntries
// inlineSummaryEntry 调用 getwi("EW/Dyn/线索") 应该返回空
assert.equal(
  customResult.allEntries.some(e => e.name === "EW/Dyn/线索"),
  false,
  "disabled entries should not enter allEntries in custom filter mode",
);
```

#### 6d. 缓存 key 区分模式和关键词

```js
// 先跑一次默认模式预热缓存
const defaultResult = await resolveTaskWorldInfo({
  settings: {},
  userMessage: "继续调查",
  templateContext: { recentMessages: "...", charName: "Alice" },
});
assert.equal(defaultResult.debug.cache.hit, false);

// 再跑自定义模式，不应命中缓存
const customResult2 = await resolveTaskWorldInfo({
  settings: { worldInfoFilterMode: "custom", worldInfoFilterCustomKeywords: "" },
  userMessage: "继续调查",
  templateContext: { recentMessages: "...", charName: "Alice" },
});
assert.equal(customResult2.debug.cache.hit, false,
  "switching filter mode should not hit default mode cache");
```

#### 6e. prompt-builder 层不做 MVU 清洗（直接 worldInfo block）

```js
// 用 buildTaskPrompt 验证自定义模式下 MVU 内容条目不被清洗
const customPromptBuild = await buildTaskPrompt(
  { ...settings, worldInfoFilterMode: "custom", worldInfoFilterCustomKeywords: "" },
  "recall",
  { taskName: "recall", userMessage: "继续调查", recentMessages: "...", charName: "Alice" },
);
// MVU heuristic 条目（content 含 status_current_variable）应出现在 systemPrompt 中
assert.match(customPromptBuild.systemPrompt, /status_current_variable/,
  "custom filter mode should not strip MVU content in prompt-builder");
```

#### 6f. 最终 block 清洗对 `{{worldInfoBefore}}` 插值块也不应删内容

补一个 profile fixture，不用 `sourceKey: "worldInfoBefore"`，而是：

```js
{
  id: "b-interp",
  type: "custom",
  content: "世界书插值:\\n{{worldInfoBefore}}",
  role: "system",
  enabled: true,
  order: 0,
  injectionMode: "append",
}
```

断言：

```js
assert.match(customInterpolatedPromptBuild.systemPrompt, /status_current_variable/);
```

这能确保 5c 的 `blockUsesWorldInfoContent()` 不是只覆盖 `sourceKey`，而是真的覆盖到了插值路径。

#### 6g. cache hit 时 `debug.customFilter` 仍正确返回

```js
const keywordResult1 = await resolveTaskWorldInfo({
  settings: { worldInfoFilterMode: "custom", worldInfoFilterCustomKeywords: "常驻" },
  userMessage: "继续调查",
  templateContext: { recentMessages: "...", charName: "Alice" },
});
assert.equal(keywordResult1.debug.cache.hit, false);
assert.equal(keywordResult1.debug.customFilter.filteredEntryCount, 1);

const keywordResult2 = await resolveTaskWorldInfo({
  settings: { worldInfoFilterMode: "custom", worldInfoFilterCustomKeywords: "常驻" },
  userMessage: "继续调查",
  templateContext: { recentMessages: "...", charName: "Alice" },
});
assert.equal(keywordResult2.debug.cache.hit, true);
assert.equal(keywordResult2.debug.customFilter.filteredEntryCount, 1);
assert.equal(keywordResult2.debug.customFilter.filteredEntries[0].name, "常驻设定");
```

#### 6h. 默认模式回归保护

必须补一条明确的“默认模式没变”回归测试，避免实现时误伤现有链路：

```js
const defaultModeResult = await resolveTaskWorldInfo({
  settings: { worldInfoFilterMode: "default", worldInfoFilterCustomKeywords: "常驻" },
  userMessage: "继续调查",
  templateContext: { recentMessages: "...", charName: "Alice" },
});

// 默认模式仍忽略自定义关键词设置
assert.equal(
  defaultModeResult.beforeEntries.some(e => e.sourceName === "常驻设定"),
  true,
);

// 默认模式仍保留原有 MVU 过滤
assert.equal(defaultModeResult.debug.mvu.filteredEntryCount > 0, true);
assert.equal(defaultModeResult.debug.customFilter.filteredEntryCount, 0);
```

---

## 不做的事

- 不修改 `mvu-compat.js`
- 不支持正则匹配（只做子串包含）
- 不按 `comment` 或 content 过滤（只按 `name`）
- 不改变默认模式下的任何现有行为（包括 disabled 条目可被 EJS getwi 读取）

---

## 风险点

1. **自定义模式下 disabled 条目不可被 EJS getwi 读取** — 与默认模式行为不同（默认允许）。这是有意设计，符合用户 "未激活状态也不要读取" 的需求。
2. **自定义模式完全跳过 MVU 清洗** — 如果用户世界书有 MVU 变量标签但没用关键词过滤掉，这些内容会原样进入 prompt。这是自定义模式的预期行为。
3. **缓存 key 包含关键词** — 每次修改关键词后第一次请求会重新加载。3 秒 TTL 影响可忽略。
