# 自主整合、进化、总结与归档

这些能力不再是提取后的固定串行阶段，也不由“每 N 次”“相似度超过 X”单独决定是否调用。它们都是 Memory Steward 在同一个开放工具循环中可组合使用的记忆修订策略。

这种设计保留了自动进化能力，同时避免每层无条件触发一次整合 LLM、拖长前台体验。Steward 在后台运行；召回只读最新已提交账本，不等待尚未完成的维护。

## 判断上下文

Steward 首先看到本批 Inbox/evidence 与当前记忆目录，然后可以按需要：

- 搜索词法或语义候选；
- 查看某个 memoryId 的当前 revision、修订历史和原始 evidence；
- 沿 relation 检查支持、矛盾、更新、时间与空间邻居；
- 对比客观层、角色 POV、用户 POV、owner 和故事时间；
- 继续翻页读取证据，而不是被固定候选池截断。

因此“重复”“冲突”“同一对象的新状态”“视角差异”“阶段总结”由模型在足够语境下判断，程序负责高效查询和硬约束，不用一组脆弱阈值替模型作语义决定。

## 记忆修订而非原地覆盖

每个稳定 `memoryId` 可以有多个不可变 revision。常见动作都用新 revision 表达：

- **保留**：当前事实仍准确，不创建新 revision；
- **补充/进化**：创建子 revision，引用新 evidence，并可依赖被更新的旧 revision；
- **整合**：创建一个信息更完整的 revision，明确列出支持证据和被吸收的依赖；
- **纠错/冲突演化**：新 revision 表达当前有效状态，旧 revision 仍可追溯；
- **归档/遗忘**：创建 `archived` revision，不物理删除历史；
- **关系修复**：为稳定 `relationId` 创建新 relation revision。

物化器只选择依赖仍有效的最新 revision。删楼或切回旧 swipe 时，相关 revision 会自动退出或重新进入视图，不需要反向执行一串图谱 mutation。

## 总结与压缩

总结也是有证据依赖的 memory revision，而不是覆盖原文：

- 短期剧情可形成 level-0 synopsis；
- 多段 synopsis 可演进为更高层摘要；
- POV 总结保持 owner/layer，不能伪装成客观事实；
- 原始 evidence 和低层 revision 始终留在账本，可供 Recall Agent 深查；
- 是否总结、覆盖哪段、保留哪些关键细节由 Steward 根据当前任务和上下文窗口决定。

“压缩”只压缩 Agent 的可见上下文与活动投影，不删 durable journal。模型上下文接近用户配置的 token 窗口时，`TokenAwareAgentContext` 对旧工具结果和对话轨迹做总结；provider 请求、工具边界和领域提交仍有完整耐久记录。

## 遗忘

遗忘是显式归档判断，不再使用固定时间公式周期性扫图。Steward 可综合：

- 是否已被更准确 revision 取代；
- 对当前故事线、规则或角色状态是否仍重要；
- 是否只是重复表述；
- evidence 是否仍有效；
- 近期召回和关系结构是否说明它仍有价值。

高价值 rule、主线和长期身份事实不会仅因“时间久/访问少”被机械删除。归档仍可通过后续新 revision 恢复。

## 原子性与并发

整合、总结或进化涉及的所有 memory/relation revision 先组成一个 Change Set：

1. `memory_stage_changes` 替换暂存方案；
2. `memory_validate_changes` 对最新账本校验；
3. `memory_commit_changes` 一次提交；
4. 若语义状态已改变，Agent refresh 后重规划；
5. 若判断无需改变，`memory_complete_without_changes` 留下明确结果并完成 Inbox。

这解决了“本层已经提取落盘，但上一层整合晚到又覆盖新图”的问题：两个任务都不能直接覆盖图谱，后到 Change Set 必须在提交时证明自己的 evidence 与读取依赖仍成立。

## 旧算法的位置

`maintenance/consolidator.js`、`compressor.js`、`hierarchical-summary.js` 中仍有旧版向量阈值、固定 fan-in 和周期算法，供旧数据迁移、测试与显式工具能力参考。生产消息事件和面板维护动作已由 Memory Steward 拥有，UI 不再暴露它们的固定频率/相似度门。
