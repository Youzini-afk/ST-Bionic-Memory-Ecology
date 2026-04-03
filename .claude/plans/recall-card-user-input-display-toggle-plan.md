# ST-BME Recall Card 用户输入显示开关方案

## 背景与用户痛点
当前 ST-BME 在聊天楼层里会额外渲染一张 Recall Card，用来展示：

- 本轮用户输入
- 相关记忆召回
- 召回节点数量
- token 估算
- 展开的召回图与注入内容

这张卡目前是“额外附着在用户消息下面”的显示层，而不是替换原始用户消息本身。因此会出现一个明显问题：

- 聊天界面里先看到原始用户输入
- Recall Card 里又重复显示一遍“本轮用户输入”

结果就是视觉重复。尤其对那些本来就自己做了用户输入栏美化的使用者来说，这张卡顶部的“本轮用户输入”区域会和现有前端样式冲突，形成一个突兀的“黄框重复展示”。

用户的核心诉求有两个：

1. “美化用户输入”必须变成可选项，不能强制显示。
2. 如果用户选择“要显示美化后的用户输入”，那就必须同步隐藏原始用户输入，不能出现两份一模一样的文本并排或上下重复。

重要边界：

- 当前插件功能实际上是可用的，问题主要在显示策略。
- 不要改召回逻辑、注入逻辑、持久化逻辑、图谱逻辑、检索逻辑。
- 这是一个 UI 显示层改造，不是功能链路重写。

## 已定位结论
这个问题已经确认是前端展示层造成的，不是后端或 prompt 注入重复。

### 1. 黄框来源
Recall Card 本体由 [recall-message-ui.js](../../recall-message-ui.js) 创建：

- `createRecallCardElement(...)` 负责生成整张卡
- 其中“本轮用户输入”部分是直接写死渲染的

关键位置：

- [recall-message-ui.js:183](../../recall-message-ui.js#L183)
- [recall-message-ui.js:203](../../recall-message-ui.js#L203)
- [recall-message-ui.js:207](../../recall-message-ui.js#L207)

### 2. 黄框样式来源
Recall Card 的外观样式在 [style.css](../../style.css)：

- 卡片容器： [style.css:2777](../../style.css#L2777)
- 用户输入 label： [style.css:2787](../../style.css#L2787)
- 用户输入文本： [style.css:2797](../../style.css#L2797)

### 3. 卡片挂载方式
Recall Card 不是一条新消息，也不是替换原消息。
它是附加在原始 user 楼层 DOM 下面：

- 锚点解析： [index.js:1822](../../index.js#L1822)
- 卡片挂载： [index.js:1999](../../index.js#L1999)

而且传入卡片的 `userMessageText` 就是原始 `message.mes`：

- [index.js:2002](../../index.js#L2002)

### 4. 后端/数据链路没有重复注入
Recall Card 展示的数据来自用户消息上的持久化 recall 记录，不是额外造了一条消息：

- 读取持久化记录： [recall-persistence.js:24](../../recall-persistence.js#L24)
- 只要有 `injectionText` 才渲染卡片： [index.js:1952](../../index.js#L1952)

因此，用户在酒馆后端看到的“只有用户输入 + 调回的记忆”这一观察是对的。现在的重复只发生在前端视觉层。

## 目标
在不改变 ST-BME 现有功能链路的前提下，为 Recall Card 增加一个“美化用户输入”的显示策略开关。

最终需要满足：

- 用户可以关闭 Recall Card 顶部那块“本轮用户输入”展示
- 用户也可以保留这块美化展示
- 当保留美化展示时，要自动隐藏原始 user 消息文本，避免视觉重复
- 当关闭美化展示时，要确保原始 user 消息文本正常显示
- 不影响记忆召回、持久化、注入、展开图谱、编辑、删除、重跑召回等现有能力

## UI 放置要求
用户指定要把“美化用户输入”的选项放在“功能开关”页，位置参考截图中的空位。

建议放置方式：

- 放在“隐藏旧楼层”这张卡附近
- 作为同级的新配置卡，或作为该区域右侧空位中的独立卡片
- 文案应一眼说明“这只是显示策略，不影响召回本身”

建议标题：

- `美化用户输入`

建议副说明：

- `控制 Recall Card 是否接管本轮用户输入的展示方式，不影响实际召回与注入。`

## 推荐方案
不要只做一个简单布尔值。更稳妥的是做成一个三态“显示模式”，这样另一位实现 AI 会更容易避免歧义。

建议新增设置字段：

- `recallCardUserInputDisplayMode`

建议取值：

1. `off`
   不在 Recall Card 内显示“本轮用户输入”区域。
   原始 user 消息保持原样显示。

2. `beautify_only`
   在 Recall Card 内显示“本轮用户输入”区域。
   同时隐藏原始 user 消息文本。
   这是最符合当前用户诉求的模式。

3. `mirror`
   在 Recall Card 内显示“本轮用户输入”区域。
   原始 user 消息也继续显示。
   这个模式保留当前行为，作为兼容选项。

默认值建议：

- 为兼容旧版本与已有用户习惯，默认值建议设为 `mirror`

原因：

- 不会改变现有安装用户的默认视觉结果
- 只是新增可选项，不会破坏已有使用体验
- 用户可以手动切换成自己想要的模式

如果维护者更希望新装即减少视觉重复，也可以考虑默认 `off`。但那属于产品决策，不是技术必须。

## 最小改动原则
这次改动必须严格限制在“显示层”和“设置层”。

允许改动：

- `index.js`
- `panel.html`
- `panel.js`
- `recall-message-ui.js`
- `style.css`

不要改动：

- `recall-controller.js`
- `retriever.js`
- `injector.js`
- `recall-persistence.js`
- 任何召回算法、注入算法、存储结构、图谱结构

## 实施方案

### 一、设置层
在 [index.js](../../index.js) 的默认设置中新增字段：

- 位置： [index.js:343](../../index.js#L343)
- 新增：`recallCardUserInputDisplayMode: "mirror"`

要求：

- 通过现有 `getSettings()` 和 `updateModuleSettings()` 走统一设置链路
- 不新增独立存储机制
- 不改服务端设置保存结构的总体行为，只是增加一个普通字段

### 二、配置面板层
在“功能开关”页面增加“美化用户输入”设置入口。

建议实现方式：

- 在 [panel.html](../../panel.html) 的 `toggles` 区块中新增一张配置卡
- 位置靠近“隐藏旧楼层”卡片，使用截图中右侧空位
- 在 [panel.js](../../panel.js) 中补充读写绑定

建议交互形式：

- 使用 `select`
- 三个选项分别对应：
  - `关闭美化，仅显示原始输入`
  - `由 Recall Card 接管显示，并隐藏原始输入`
  - `Recall Card 与原始输入同时显示（兼容模式）`

为什么不建议只放 checkbox：

- 因为 checkbox 很难同时表达“关闭”“替代”“保留重复”三种模式
- 三态更清楚，也更利于向后兼容

如果 UI 组件层面确实只适合 checkbox，也可以退化为：

- `启用用户输入美化`
- `启用后隐藏原始用户输入`

但三态仍然是首选。

### 三、Recall Card 渲染层
在 [recall-message-ui.js](../../recall-message-ui.js) 里，只改“本轮用户输入”这块的渲染条件，不动其他内容。

具体要求：

- `createRecallCardElement(...)` 增加一个新的显示模式参数
- `updateRecallCardData(...)` 也能同步接收该模式
- 当模式为 `off` 时：
  - 不创建 `userLabel`
  - 不创建 `userText`
  - 或者创建后直接隐藏，但更推荐不创建
- 当模式为 `beautify_only` 或 `mirror` 时：
  - 保持现有用户输入区渲染

不要改动：

- 召回条
- 节点数 badge
- token hint
- 展开/折叠
- 图谱渲染
- 注入文本展示
- 编辑/删除/重跑召回按钮逻辑

### 四、原始用户输入隐藏层
这部分是本次方案的关键，也是最容易误伤其他逻辑的地方。

目标：

- 只隐藏原始 user 消息正文文本
- 不能把整条 `.mes` 或 `.mes_block` 隐藏掉
- 否则 Recall Card 自己也会跟着消失

建议做法：

1. 在 `index.js` 的 Recall Card 刷新流程中，拿到目标 `messageElement` 后：
   - 定位其原始文本容器，优先找 `.mes_text`
2. 根据 `recallCardUserInputDisplayMode` 决定是否给该文本容器加一个 ST-BME 专用 class 或 data attribute
3. 在 `style.css` 里为这个专用 class 提供隐藏样式

建议新增 class：

- `bme-hide-original-user-text`

建议样式原则：

- 仅隐藏文本区域本身
- 不要影响按钮区、头像区、楼层容器尺寸计算

这里推荐优先用“受控 class 切换”，不要直接写行内 `display:none`，原因是：

- 刷新时更容易恢复
- DOM 重绘后更容易重新应用
- 更利于调试

强制实现约束：

- 只能在当前目标楼层的 `messageElement` 作用域内查找 `.mes_text`
- 推荐写法是 `messageElement.querySelector('.mes_text')`
- 不允许使用 `document.querySelectorAll('.mes_text')`、全局批量扫描后再按索引猜测匹配对象，或任何会波及其他楼层的全局操作

原因：

- 这个需求只应该影响“当前挂载 Recall Card 的那一条 user 楼层”
- 如果实现成全局 `.mes_text` 操作，最容易出现误隐藏其他消息、切换模式后残留、以及聊天重绘时状态串楼层的问题

### 五、刷新与恢复逻辑
Recall Card UI 不是一次性静态渲染，而是会随消息刷新、设置变更、聊天切换重新挂载或更新。

因此必须保证：

- 切到 `beautify_only` 时，已存在的卡片能立即隐藏原始输入
- 切到 `off` 或 `mirror` 时，已隐藏的原始输入能立即恢复
- 删除 Recall Card 时，原始输入也要恢复
- 聊天切换或楼层 DOM 重建后，显示状态能重新正确应用

建议实现策略：

- 在 `refreshPersistedRecallMessageUi()` 流程中统一应用
- 在 `cleanupRecallArtifacts(...)` / `cleanupRecallCardElement(...)` 附近补一层“恢复原始文本显示”的兜底
- 在设置更新时，若 patch 包含 `recallCardUserInputDisplayMode`，主动触发一次 Recall Card UI refresh

## 兼容性要求

### 必须保持不变
- Recall 是否执行
- Recall 结果如何写入持久化记录
- 注入文本如何进入 prompt
- token 估算
- 展开的节点图
- 编辑 recall 注入文本
- 删除 recall 记录
- 重跑 recall
- 非 user 楼层不挂载 Recall Card 的规则

### 必须新增保证
- 无论用户怎样切换这个显示模式，都不能影响后端实际发送内容
- 无论用户怎样切换这个显示模式，都不能让 recall 记录丢失
- 无论用户怎样切换这个显示模式，都不能改变注入结果

## 建议验收场景
另一位实现 AI 可以按下面场景验收。

### 场景 1：兼容模式
设置为 `mirror`

期望：

- 行为与当前版本一致
- 原始用户输入可见
- Recall Card 顶部“本轮用户输入”也可见

### 场景 2：关闭美化
设置为 `off`

期望：

- 原始用户输入可见
- Recall Card 仍保留“相关记忆召回”条、节点数、token、展开内容
- 只是顶部“本轮用户输入”区域不再显示

### 场景 3：美化接管
设置为 `beautify_only`

期望：

- 原始用户输入文本被隐藏
- Recall Card 顶部“本轮用户输入”仍显示
- 聊天界面不再看到两份重复文本

### 场景 4：设置动态切换
在已有聊天记录上来回切换三种模式

期望：

- 不需要重开聊天
- UI 立即生效
- 不出现隐藏状态残留

### 场景 5：删除 recall 记录
在 `beautify_only` 模式下删除某条 Recall Card

期望：

- Recall Card 消失
- 原始用户输入文本恢复显示

### 场景 6：刷新 / 切聊天 / 重新挂载

期望：

- 模式设置持久生效
- DOM 重建后显示仍然正确

### 场景 7：多条消息并存时的作用域验证

期望：

- 在一个有多条 user 消息、且其中只有部分楼层存在 Recall Card 的聊天里
- 切换 `beautify_only` 时，只隐藏挂载了 Recall Card 的目标楼层原始文本
- 没有 Recall Card 的其他 user 楼层不得被隐藏
- 切回 `off` 或 `mirror` 时，只恢复对应目标楼层，不出现跨楼层串改

## 风险点与防误改提醒

### 风险 1：误把整条消息隐藏
如果实现时隐藏的是 `.mes`、`.mes_block` 或更外层容器，会把 Recall Card 自己也一起隐藏。

正确做法：

- 只处理原始用户文本区域
- 而且这个文本区域必须通过当前 `messageElement` 局部查询获得，不能用全局 `.mes_text` 选择器批量处理

### 风险 2：把显示问题误改成数据问题
这个需求不是要删 `message.mes`，也不是要清理持久化 recall 记录。

正确做法：

- 只改 DOM 渲染与 class 切换

### 风险 3：设置切换后残留隐藏状态
如果只在创建卡片时加隐藏样式，而不在 refresh / cleanup 时恢复，会导致切换模式后文本状态错乱。

正确做法：

- 在刷新和清理路径都处理恢复逻辑

### 风险 4：误动 Recall Card 其他区域
用户只对“本轮用户输入这块美化显示”有意见，不是要取消整个 Recall Card。

正确做法：

- 只拆分顶部 user-input 区块的显示策略
- 保留下面的 recall bar 与展开内容

## 推荐实施顺序

1. 在 `index.js` 增加默认设置字段
2. 在 `panel.html` / `panel.js` 增加配置项，并放到“功能开关”页截图所示空位
3. 在 `recall-message-ui.js` 给顶部 user-input 区块加显示模式控制
4. 在 `index.js` 增加“隐藏/恢复原始 user 文本”的 DOM 协调逻辑
5. 在 `style.css` 增加专用隐藏 class
6. 跑一轮上述验收场景

## 给实现 AI 的一句话总结
这次改动的本质是：

- 保留 Recall Card 功能
- 只把 Recall Card 顶部“本轮用户输入”的显示变成可选
- 并在“由 Recall Card 接管显示”时隐藏原始 user 文本
- 不要动任何 recall / injection / persistence 的核心逻辑
