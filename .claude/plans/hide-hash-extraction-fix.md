# ST-BME: 隐藏旧楼层 × 自动提取 × 历史恢复 问题修复计划（收紧版）

## 目标

把当前现象拆成两类问题分别处理，避免把“已证实的根因”和“待确认的假设”混在一起：

1. **已证实问题**：隐藏旧楼层会改动 `is_system`，而历史完整性哈希把 `is_system` 算进去，导致误判历史被改动，进而触发错误恢复，甚至形成恢复循环。
2. **待确认问题**：新聊天里自动提取不启动，当前最可疑的是图谱持久化就绪时序，但还没有足够证据证明它与上面的哈希误判属于同一条因果链。

---

## 当前观察到的症状

### 症状 A：新聊天中自动提取似乎不启动

- 新开聊天，聊了多层后，“历史状态”仍显示“干净，已处理到楼层 -1”
- 手动点击“手动提取”后，`lastProcessedAssistantFloor` 才推进

### 症状 B：手动提取成功后，再聊一层会误触发历史恢复

- 提示类似：

> ⚠ 楼层 4 内容或 swipe 已变化
> 检测到楼层历史变化，将从楼层 4 之后自动恢复图谱

### 症状 C：触发恢复后界面表现为“提取卡住”

- 面板显示“ST-BME 提取 - AI 生成中...”
- Console 没有明显新的推进日志
- 更可能是恢复与后续自动提取反复触发，表现为“看起来挂住”

---

## 已确认的代码事实

### 1. 自动提取入口确实存在

- [`event-binding.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\event-binding.js) 的 `onMessageReceivedController`
- 收到 assistant 消息后，会排一个 microtask 调用 `runExtraction()`

### 2. 自动提取确实会被图谱未就绪挡住

- [`extraction-controller.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\extraction-controller.js) 的 `runExtractionController`
- Guard 3：

```js
if (!runtime.ensureGraphMutationReady("自动提取", { notify: false })) {
  runtime.deferAutoExtraction?.("graph-not-ready");
  return;
}
```

- [`index.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\index.js) 的 `deferAutoExtraction` / `maybeResumePendingAutoExtraction` 也确实存在持续重试逻辑

### 3. 隐藏旧楼层会直接改 `message.is_system`

- [`hide-engine.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\hide-engine.js) 的 `markManagedSystemRange`
- 会把消息对象直接写成 `message.is_system = true`
- 同时写入 `message.extra.__st_bme_hide_managed = true`
- [`restoreManagedSystemFlags`] 会把这些消息重新改回 `is_system = false`

### 4. 历史完整性哈希当前包含 `isSystem`

- [`runtime-state.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\runtime-state.js) 的 `buildMessageHash`

```js
const payload = JSON.stringify({
  isUser: Boolean(message?.is_user),
  isSystem: managedHideMarker ? false : Boolean(message?.is_system),
  text: String(message?.mes || ""),
  swipeId,
});
```

### 5. 历史恢复就是基于这个哈希差异触发的

- [`runtime-state.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\runtime-state.js) 的 `detectHistoryMutation`
- [`index.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\index.js) 的 `inspectHistoryMutation` / `recoverHistoryIfNeeded`

因此，**“隐藏逻辑改了 `is_system`，而历史哈希又把 `is_system` 当成内容真相的一部分”这一矛盾是已坐实的。**

---

## 根因划分

### 根因 1（已确认）：`is_system` 被错误纳入历史完整性判断

这是症状 B、C 的主根因。

#### 问题链条

1. 某次提取完成后，系统对已处理楼层拍快照
2. 快照中的哈希包含 `isSystem`
3. 旧楼层隐藏逻辑随后执行，会改动部分消息的 `is_system`
4. 后续完整性检查重新计算哈希时，发现同一楼层 hash 不一致
5. `detectHistoryMutation` 误以为消息内容或 swipe 发生变化
6. 触发 `recoverHistoryIfNeeded`
7. 若恢复后又再次遇到同类误判，就可能出现“恢复 -> 再检查 -> 再恢复”的循环

#### 关键结论

- `is_system` 在这里更像一种**展示/隐藏副作用**
- 它不应作为“消息历史真实性”的核心判据
- 否则隐藏功能会污染历史恢复机制

### 根因 2（待确认）：自动提取在新聊天中的启动/恢复时序不稳

这是症状 A 的最可疑原因，但**目前还不能写死为已确认根因**。

#### 当前证据

- 自动提取入口存在
- Guard 3 会在 DB 未就绪时阻断
- 阻断后会走 `deferAutoExtraction`
- resume 逻辑理论上会持续重试，不是一次失败就永久放弃

#### 当前仍不确定的点

- 新聊天里究竟是否一直卡在 `ensureGraphMutationReady`
- 还是 `MESSAGE_RECEIVED` 实际没有按预期命中 assistant 消息
- 还是 defer/resume 被别的状态反复打断
- 还是 load state 在某些聊天中长期停在非 ready 状态

所以，症状 A 目前应视为一个**独立待诊断问题**，而不是直接并入“隐藏哈希误判”这条链。

---

## 修复方案

### 修复 A（核心，直接做）：从 `buildMessageHash` 中移除 `isSystem`

**目标文件**：[`runtime-state.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\runtime-state.js)

#### 当前实现

```js
export function buildMessageHash(message) {
  const managedHideMarker = Boolean(
    message?.extra &&
      typeof message.extra === "object" &&
      message.extra.__st_bme_hide_managed === true,
  );
  const swipeId = Number.isFinite(message?.swipe_id) ? message.swipe_id : null;
  const payload = JSON.stringify({
    isUser: Boolean(message?.is_user),
    isSystem: managedHideMarker ? false : Boolean(message?.is_system),
    text: String(message?.mes || ""),
    swipeId,
  });
  return String(stableHashString(payload));
}
```

#### 建议修改

```js
export function buildMessageHash(message) {
  const swipeId = Number.isFinite(message?.swipe_id) ? message.swipe_id : null;
  const payload = JSON.stringify({
    isUser: Boolean(message?.is_user),
    text: String(message?.mes || ""),
    swipeId,
  });
  return String(stableHashString(payload));
}
```

#### 理由

- `is_system` 的变化不等于消息内容被编辑
- `text + swipeId + isUser` 已经足够覆盖绝大多数真正影响提取语义的变化
- 这能直接切断“隐藏副作用 -> hash 变化 -> 误恢复”的链路

#### 风险

- 如果用户真的手动把一条消息从普通消息改成系统消息，这个变化将不再被历史恢复逻辑视为“内容变更”
- 但这种操作相对罕见，而且比起当前误恢复问题，这个代价是可以接受的

### 修复 A-1（必须配套）：加入快照哈希版本迁移

**这不是可选备注，而应作为正式方案的一部分。**

如果只改 `buildMessageHash` 而不做迁移：

- 旧快照是“含 `isSystem`”算法算出的
- 新代码会用“不含 `isSystem`”算法重新计算
- 第一次完整性检查几乎必然把所有已处理楼层判成 dirty
- 这会触发一次高代价恢复/重建

#### 推荐做法

给历史快照引入一个明确的 hash schema version，例如：

- `historyState.processedMessageHashVersion = 2`

加载图状态时：

1. 若版本缺失或旧于当前版本
2. 不走“历史被篡改”的判断
3. 直接清空旧 `processedMessageHashes`
4. 基于当前聊天内容重新拍一份新快照
5. 更新版本号

#### 目标

- 避免升级后第一次运行就误触发一次全量恢复
- 把这次变化当成“哈希算法升级”，而不是“聊天历史损坏”

### 修复 B（设计收敛，次优先）：减少或移除 BME 对 `is_system` 的双写

**目标文件**：[`hide-engine.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\hide-engine.js)

当前隐藏引擎已经调用宿主的 `/hide` 和 `/unhide`，但仍然自己改：

- `message.is_system`
- DOM 上的 `is_system` attribute
- `__st_bme_hide_managed`

这说明现在是“宿主隐藏 + BME 本地 system 标记”双轨并存，副作用偏大。

#### 建议

先确认宿主 `/hide` 的真实语义：

1. `/hide` 是否已经足以让主 AI 和 UI 正常隐藏旧消息
2. `/hide` 是否会自行管理 `is_system`
3. BME 是否还有任何逻辑依赖 `message.is_system` 来跳过消息

#### 若确认不再需要本地双写

则逐步去掉：

- `markManagedSystemRange`
- `restoreManagedSystemFlags`
- `syncSystemAttribute`
- `__st_bme_hide_managed` 相关用途

#### 注意

这一步是“降低副作用、收敛设计”的改进，不是修复症状 B/C 的前提。  
**真正阻断误恢复的是修复 A。**

### 修复 C（诊断，尽快做）：给自动提取 guard 和 resume 点加日志

**目标文件**：

- [`extraction-controller.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\extraction-controller.js)
- [`index.js`](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\index.js)

#### 建议打点位置

1. `runExtractionController` 每个 return 前
2. `ensureGraphMutationReady` 返回 false 的分支
3. `deferAutoExtraction`
4. `maybeResumePendingAutoExtraction`
5. `onMessageReceivedController` 命中 assistant 消息时

#### 目标不是长期保留大量日志

而是回答这几个问题：

- 新聊天时是否真的进入了 `runExtraction`
- 是否总卡在 `graph-not-ready`
- defer 是否持续排队
- resume 是否真的被触发
- resume 后是否又被 `extracting` / `history-recovering` / `graph-not-ready` 打回

只有拿到这些证据，才能决定症状 A 下一步是：

- 调整 load-ready 时机
- 在 chat loaded / chat changed 后主动 resume 一次
- 还是修正 assistant message 识别逻辑

---

## 不建议在文档里写死的说法

以下表述建议从“结论”降级为“待验证假设”：

### 1. “三个症状是同一条因果链”

建议改为：

- 症状 B/C 已有统一根因
- 症状 A 暂时独立排查

### 2. “自动提取比隐藏重算更早执行，因此会读到隐藏中间态”

从当前代码时序看，这个说法不够稳。

- 自动提取：`MESSAGE_RECEIVED` microtask
- 隐藏重算：`GENERATION_ENDED` 后 180ms 调度

更稳妥的写法是：

- 隐藏逻辑会改动消息对象的 `is_system`
- 历史哈希又把 `is_system` 算进去了
- 因此在后续任一完整性检查时都可能误判 dirty

不必把主要解释建立在“正好撞上中间态”之上。

---

## 实施顺序

1. **先做修复 A**
   从历史哈希中移除 `isSystem`
2. **立刻配套修复 A-1**
   加入快照哈希版本迁移，避免升级后误触发全量恢复
3. **并行做修复 C**
   加最小必要日志，单独定位症状 A
4. **最后评估修复 B**
   收敛隐藏引擎，减少 `is_system` 相关副作用

---

## 验收标准

### 针对症状 B/C

1. 手动提取成功后，再聊一层
2. 不再出现“楼层 X 内容或 swipe 已变化”的误恢复提示
3. `recoverHistoryIfNeeded` 不会因为纯隐藏操作反复触发
4. 面板不会再卡在“AI 生成中...”但无实际推进

### 针对升级迁移

1. 更新到新版本后
2. 不因 hash 算法变化直接触发一次全量恢复
3. `processedMessageHashes` 能平滑迁移到新版本

### 针对症状 A

1. 新聊天中收到 assistant 消息后能看到明确日志链路
2. 能判断问题究竟发生在：
   - 事件未命中
   - graph-not-ready
   - defer/resume 丢失
   - history-recovering 打断
   - 其他 guard

---

## 关键文件索引

| 文件 | 关键函数 | 用途 |
|------|----------|------|
| `runtime-state.js` | `buildMessageHash` | 历史完整性哈希计算 |
| `runtime-state.js` | `snapshotProcessedMessageHashes` | 拍快照 |
| `runtime-state.js` | `detectHistoryMutation` | hash 对比与 dirty 判断 |
| `hide-engine.js` | `markManagedSystemRange` | 本地写 `is_system` |
| `hide-engine.js` | `restoreManagedSystemFlags` | 撤销本地写 `is_system` |
| `hide-engine.js` | `syncSystemAttribute` | 同步 DOM `is_system` attribute |
| `hide-engine.js` | `runHideApply` | 隐藏主流程 |
| `extraction-controller.js` | `runExtractionController` | 自动提取主流程 |
| `event-binding.js` | `onMessageReceivedController` | 自动提取事件入口 |
| `index.js` | `ensureGraphMutationReady` | 图谱写入前置就绪判断 |
| `index.js` | `deferAutoExtraction` | 自动提取延迟重试 |
| `index.js` | `maybeResumePendingAutoExtraction` | 自动提取恢复 |
| `index.js` | `updateProcessedHistorySnapshot` | 更新处理后快照 |
| `index.js` | `inspectHistoryMutation` | 历史检查入口 |
| `index.js` | `recoverHistoryIfNeeded` | 历史恢复主流程 |
| `index.js` | `scheduleMessageHideApply` | 隐藏调度 |
