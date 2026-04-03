# ST-BME：旧楼层隐藏解耦 + Timer Blocker 修复计划

## 这份计划是给谁看的

给接手这件事的另一个 AI / 开发者快速建立上下文用。  
目标是让对方**不用再向用户追问背景**，直接理解：

1. 用户真正想解决的痛点是什么
2. 目前代码已经修到哪一步了
3. 当前还卡着哪些 blocker
4. 下一步该按什么顺序、以多保守的方式去改

---

## 用户的真实痛点

用户要的不是单纯“修一个 bug”，而是下面这套行为最终成立：

1. **主 AI 节省 token**
   旧楼层自动隐藏，主 AI 不再看到太老的消息
2. **BME 仍能正常提取**
   即使旧楼层被隐藏，BME 也还能按固定上下文窗口读取所需消息，不会因为隐藏而读不到
3. **不要再因为隐藏状态变化误触发历史恢复**
4. **不要让 `is_system` 成为隐藏系统与提取系统之间的耦合桥梁**

用户想要的理想设计可以概括成一句话：

> 旧楼层隐藏只负责 `/hide` / `/unhide`，BME 提取自己按固定窗口读消息，两套逻辑解耦。

---

## 当前已经确认的事实

### 1. 当前隐藏逻辑不是纯 `/hide`

当前仓库里的旧楼层隐藏是**双轨**：

1. 调宿主 `/hide N-M` / `/unhide N-M`
2. 同时本地改 `message.is_system`
3. 同时同步 DOM 上的 `is_system` attribute

证据：

- [hide-engine.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\hide-engine.js)
  - `markManagedSystemRange`
  - `restoreManagedSystemFlags`
  - `syncSystemAttribute`
  - `runHideApply`

### 2. 当前 BME 提取链路确实会按 `is_system` 跳过消息

这点非常关键，说明“只删隐藏引擎里的 `is_system` 双写”还不够。

证据：

- [chat-history.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\chat-history.js)
  - `isAssistantChatMessage(message) => !message.is_user && !message.is_system`
  - `buildExtractionMessages(...)` 中 `if (msg.is_system) continue`
  - playableSeq / assistant floor 映射里也会跳过 `is_system`
- [index.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\index.js)
  - 例如 `pendingMessages = ...filter((msg) => !msg.is_system)`

结论：

> 当前 BME 的“可提取消息集合”仍然受 `is_system` 影响。

### 3. 历史 hash 误恢复问题已经基本修过一轮

已经做过的修复：

1. `buildMessageHash` 已不再把 `isSystem` 计入 hash
2. 已加入 `processedMessageHashVersion` 迁移逻辑
3. 之前“隐藏状态变化 -> hash 脏 -> 误触发历史恢复”的链路，实测已明显缓解

证据：

- [runtime-state.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\runtime-state.js)
- [index.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\index.js)

结论：

> 现在“是否能做纯 `/hide` 设计”的主要阻碍，已经不再是 hash，而是提取链路仍依赖 `is_system`。

### 4. 当前还有独立的事件层 blocker，导致测试结果会被污染

已发现两类 `Illegal invocation`：

1. `MESSAGE_RECEIVED` 路径里的 `queueMicrotask` 借壳调用问题
2. `CHAT_CHANGED` 路径里的 `clearTimeout` 借壳调用问题

用户最新测试显示：

- 新聊天刚切换时就在 `onChatChangedController` 崩掉
- 面板出现“等待图谱加载”
- 这种状态下继续测自动提取 / 隐藏逻辑，结论不干净

证据：

- [event-binding.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\event-binding.js)
  - `onChatChangedController`
  - `scheduleSendIntentHookRetryController`
  - `onMessageReceivedController`

---

## 用户当前最关心的两个问题

### 问题 A：最终能不能做成“只 `/hide`，不碰 `is_system`”？

答案：

**可以朝这个方向改，但不能只改 hide-engine。**

如果只删：

- `markManagedSystemRange`
- `restoreManagedSystemFlags`

而不改提取链路，那么当前 BME 仍然可能因为：

1. 宿主 `/hide` 自己修改了 `is_system`
2. 或者 BME 当前仍按 `is_system` 过滤消息

而导致：

- 提取读不到被隐藏楼层
- assistant turn 识别错位
- 上下文窗口与可见消息集合混在一起

### 问题 B：现在能不能继续测聊天行为？

答案：

**不建议。**

因为 `onChatChangedController` 当前还有 `Illegal invocation`，会污染新聊天初始化流程。  
在这个 blocker 修掉之前，继续测：

- 自动提取是否触发
- 图谱加载是否正常
- 隐藏与提取是否协同

得到的结果都不可靠。

---

## 对另一个 AI 的核心提醒

### 不要误判为“只要去掉 hide-engine 的 `is_system` 双写就结束了”

真正需要拆开的，是两件事：

1. **主 AI 的上下文可见性**
   由 `/hide` / `/unhide` 控制
2. **BME 提取的上下文读取**
   应由 `extractContextTurns` 等窗口逻辑控制

当前代码里，这两件事都还部分依赖 `is_system`，所以必须一起梳理。

### 不要误判为“继续沿用 `runtime.clearTimeout(...)` 直接调用没问题”

当前已经出现实证：

- `queueMicrotask` 直接借 runtime 调用会触发 `Illegal invocation`
- `clearTimeout` 直接借 runtime 调用也会触发 `Illegal invocation`

说明这些原生 API 不适合直接裸调 runtime 透传引用。

---

## 推荐方案总览

建议按两个阶段推进，而不是混成一个大改：

### 阶段 1：先清理事件层 blocker，恢复干净测试环境

#### 目标

修掉新聊天 / 收消息路径里的 `Illegal invocation`，确保后续功能测试有效。

#### 推荐修法

不要粗暴把所有 `runtime.setTimeout/clearTimeout` 改成 `globalThis.*`。  
更稳的做法是：

1. 在 [event-binding.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\event-binding.js) 中引入一个本地 timer wrapper
2. 模式与 [hide-engine.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\hide-engine.js) 的 `getTimerApi()` 保持一致
3. 继续优先使用 runtime 提供的 timer
4. 但通过 `Reflect.apply(..., globalThis, args)` 安全调用

#### 理由

这样可以同时保留：

1. runtime 注入 timer 的可测试性 / 可替换性
2. 避免 `Illegal invocation`
3. 与仓库现有模式一致，降低风格分裂

#### 阶段 1 需要修改的点

- [event-binding.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\event-binding.js)
  - 新增本地 `getTimerApi(runtime)` 或等价 helper
  - `scheduleSendIntentHookRetryController`
  - `onChatChangedController`
  - 如有其他 runtime timer 裸调，也一起替换

#### 阶段 1 验收标准

1. 新开聊天不再报 `onChatChangedController ... Illegal invocation`
2. 收到 assistant 消息时不再报 `onMessageReceivedController ... Illegal invocation`
3. 新聊天可以正常进入图谱加载 / 自动提取链路

---

### 阶段 2：推进“纯 `/hide` + 提取解耦”

#### 目标

最终实现：

1. 隐藏系统只负责主 AI 可见性
2. BME 提取系统只负责按窗口读取上下文
3. `is_system` 不再是两者之间的耦合信号

#### 先做的确认

需要先确认宿主 ST 的 `/hide` / `/unhide` 真实语义：

1. `/hide` 是否会改消息对象的 `is_system`
2. `/unhide` 是否会恢复
3. 变化是 UI 层面的，还是底层 chat 数据层面的

这个确认很重要，因为它决定：

- 纯 `/hide` 后 BME 是否仍会在当前实现下跳过被隐藏消息

#### 改造顺序

##### 步骤 2-1：清点所有“提取链路按 `is_system` 过滤消息”的位置

重点：

- [chat-history.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\chat-history.js)
  - `isAssistantChatMessage`
  - `getAssistantTurns`
  - `buildExtractionMessages`
  - playableSeq / assistantSeq 映射
- [index.js](C:\Users\brian\OneDrive\Desktop\ST-Bionic-Memory-Ecology-past\index.js)
  - 所有影响 extraction 的 `!msg.is_system` 过滤

##### 步骤 2-2：把 extraction 上下文改成按窗口/索引读取

原则：

1. extraction 读取“聊天真实楼层窗口”
2. 上下文范围由 `extractContextTurns` 控制
3. 不再把“是否 hidden/system”当成提取可见性的主判据

##### 步骤 2-3：重新定义 assistant turn 识别

当前 assistant turn 识别依赖：

- `!message.is_user && !message.is_system`

这会把被隐藏的 assistant 楼层排除掉。  
需要把“真正系统消息”和“被隐藏的普通历史楼层”区分开来。

##### 步骤 2-4：在确认 extraction 已解耦后，再收敛 hide-engine

届时才安全移除：

- `markManagedSystemRange`
- `restoreManagedSystemFlags`
- `syncSystemAttribute`
- `__st_bme_hide_managed` 相关逻辑

让 hide-engine 回归为：

1. 计算范围
2. 调 `/hide`
3. 调 `/unhide`
4. 不再改本地 `is_system`

#### 阶段 2 验收标准

1. 主 AI 仍然只看到最近 N 条消息
2. BME 在隐藏开启时仍能提取到所需上下文
3. 手动提取后继续聊天，不再误报历史变化
4. assistant turn 识别不因 hidden/system 混淆而错位

---

## 为什么不建议“现在直接删掉 `is_system` 双写试试看”

因为这会同时引入两个不确定性：

1. 宿主 `/hide` 是否自己也会改 `is_system`，尚未确认
2. BME 当前 extraction 仍依赖 `is_system` 过滤消息，已确认

如果现在直接删双写，出现问题时将很难判断到底是：

1. 宿主 `/hide` 的语义问题
2. extraction 过滤逻辑没拆干净
3. assistant turn 识别仍依赖 `is_system`

因此更稳的方式是：

1. 先恢复干净测试环境
2. 再把 extraction 与 `is_system` 的耦合逐层拆掉
3. 最后再收敛 hide-engine

---

## 这份计划背后的核心逻辑

### 逻辑 1：主 AI 的“可见性”与 BME 的“可提取性”是两套规则

如果继续让二者共享 `is_system` 这一信号，就会不断出现：

- 为了主 AI 节流而牺牲 BME 提取
- 或为了 BME 提取而破坏主 AI 隐藏

### 逻辑 2：当前最大的技术债不是 hash，而是耦合

hash 误恢复这部分已经修过一轮。  
真正要彻底收尾，必须把：

- hide-engine
- extraction
- assistant turn 识别

从“共同依赖 `is_system`”改成“职责分离”。

### 逻辑 3：当前测试 blocker 必须先清掉

在 `CHAT_CHANGED` 和 `MESSAGE_RECEIVED` 都可能因原生 API 借壳调用而报 `Illegal invocation` 的情况下，继续测试高层行为没有意义。

---

## 当前建议的执行顺序

1. 修 `event-binding.js` 中 timer / microtask 的安全调用问题
2. 验证新聊天初始化、图谱加载、自动提取链路恢复正常
3. 确认宿主 `/hide` / `/unhide` 的真实数据层语义
4. 梳理 extraction 对 `is_system` 的依赖
5. 改成按窗口读取提取上下文
6. 最后移除 hide-engine 的本地 `is_system` 双写

---

## 给另一个 AI 的一句话摘要

> 用户的目标不是单纯修 bug，而是把“主 AI 隐藏旧楼层”和“BME 读取提取上下文”彻底解耦：隐藏系统最终应只做 `/hide`/`/unhide`，BME 提取应按固定窗口读真实楼层；当前 blocker 是 `event-binding.js` 中 runtime 透传的原生 timer/microtask API 直接调用导致 `Illegal invocation`，需先用与 `hide-engine.js` 一致的安全 wrapper 修复测试环境，再推进 extraction 去 `is_system` 依赖，最后才能安全移除 hide-engine 的本地 `is_system` 双写。  
