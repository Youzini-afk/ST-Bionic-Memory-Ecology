# 图扩散与动态评分

检索管线里两个核心数值算法：图扩散（PEDSA 扩散激活）和混合评分（含访问强化/时间衰减）。

## 图扩散（PEDSA）

实现在 `retrieval/diffusion.js`，是 PEDSA 式的扩散激活（spreading activation）。这是 JS 单线程的简化实现（无 Rayon/SIMD，见文件头注释）。

### 核心公式

```
E_{t+1}(j) = Σ E_t(i) × W_ij × D_decay
```

能量从种子节点沿边扩散，每步衰减。

### 默认参数

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `maxSteps` | 2 | 扩散步数 |
| `decayFactor` | 0.6 | 每步衰减 |
| `topK` | 100 | 保留节点数（按绝对能量） |
| `minEnergy` | 0.01 | 能量过滤下限 |
| `maxEnergy` / clamp | 2.0 / -2.0 | 能量上下限 |
| `teleportAlpha` | 0.0（检索路径用 0.15） | PPR 式传送 |
| `inhibitMultiplier` | 2.0 | 抑制边放大 |

### 种子构建

种子能量被夹在 `[-2, 2]`，同 ID 累加。

- **常规召回种子**：向量命中 `energy = score`，精确名称/标题锚点 `energy = 2.0`。
- **交叉/残差种子**：向量命中、精确锚点 2.0、残差命中按 score、事件邻居 `1.5 × edge.strength`。

### 扩散步骤

对每个活跃节点的每条出边：

- **正向传播**：`propagated = energy × strength × decayFactor × (1 - teleportAlpha)`
- **抑制边**（edge type 255）：`propagated = -|energy| × strength × decayFactor × inhibitMultiplier`

累加到下一步能量，夹紧并按 `|energy| >= minEnergy` 过滤。`teleportAlpha > 0` 时对初始种子做 PPR 式传送：`teleported = (1 - teleportAlpha) × current + teleportAlpha × seedEnergy`。动态剪枝保留绝对能量 top K。

### 排序

`diffuseAndRank()` 只保留正能量节点，按能量降序（同分按 nodeId）输出 `{nodeId, energy}`。

### 时序合成边

扩散使用 `buildTemporalAdjacencyMap()` 注入时序链接。默认 `enableTemporalLinks=true`、`temporalLinkStrength=0.2`——让时间上相邻的记忆之间有弱连接，帮助按时间线扩散。

## 混合评分

实现在 `retrieval/dynamics.js`。

### 公式

```
FinalScore = (normGraph×α + normVec×β + normLexical×δ + normImportance×γ) / totalWeight × TimeDecay
```

> 注意：`dynamics.js` 头注释的公式省略了词法分，实际代码包含 `lexicalScore`（启用词法增强时）。

### 权重默认

| 权重 | 默认 | 信号 |
| --- | --- | --- |
| `graphWeight` (α) | 0.6 | 图扩散邻近度 |
| `vectorWeight` (β) | 0.3 | 向量相似度 |
| `importanceWeight` (γ) | 0.1 | 节点重要度 |
| `lexicalWeight` (δ) | 0（常规召回默认 0.18） | 词法匹配 |

### 归一化

```
normGraph      = clamp(graphScore / 2.0, 0, 1)
normVec        = clamp(vectorScore, 0, 1)
normLexical    = clamp(lexicalScore, 0, 1)
normImportance = clamp(importance / 10.0, 0, 1)
```

### 时间衰减

```
deltaDays = max(0, (now - createdTime) / 一天毫秒数)
factor    = 0.8 + 0.2 / (1 + ln(1 + deltaDays))
```

越新的记忆衰减因子越接近 1，越旧越接近 0.8（不会衰减到 0，保留底线）。

## 访问强化与边衰减

### 访问强化（`reinforceAccess`）

被召回选中的节点：

```
accessCount += 1
importance   = min(10, (importance || 5) + 0.1)
lastAccessTime = now
```

经常被召回的记忆重要度缓慢上升——一种使用频率的正反馈。

### 边衰减（`reinforceEdge`，辅助）

```
被激活的边：strength = min(1.0, strength + decayRate × 0.5)
未激活的边：strength = max(0.1, strength - decayRate)
默认 decayRate = 0.02
```

> 说明：该边衰减辅助函数在当前检索/写入主路径中未见调用，属于预留能力。
