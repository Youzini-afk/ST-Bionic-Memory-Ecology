import { cloneDomainValue } from "../domain/memory-id.js";
import { getActiveNodes } from "../graph/graph.js";
import {
  normalizeRecallInjectionPlan,
  RECALL_INJECTION_ROLES,
  RECALL_INJECTION_STRATEGIES,
} from "./recall-injection-plan.js";

function toolDefinition(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function stringArraySchema(description = "") {
  return { type: "array", items: { type: "string" }, description };
}

function uniqueStrings(values = []) {
  return [
    ...new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
}

function projectNode(node) {
  if (!node) return null;
  return {
    memoryId: String(node.id || ""),
    memoryType: String(node.type || ""),
    layer: String(node.memoryLayer || node.scope?.layer || "objective"),
    fields: cloneDomainValue(node.fields, {}),
    scope: cloneDomainValue(node.scope, {}),
    storyTime: cloneDomainValue(node.storyTime, {}),
    storyTimeSpan: cloneDomainValue(node.storyTimeSpan, {}),
    importance: Number(node.importance || 0),
    confidence: Number(node.memoryConfidence ?? 1),
    sourceFloor: Number(node.sourceFloor ?? node.seq ?? 0),
  };
}

function edgeEndpoint(edge, side) {
  const candidates =
    side === "from"
      ? [edge?.from, edge?.source, edge?.fromId, edge?.fromMemoryId]
      : [edge?.to, edge?.target, edge?.toId, edge?.toMemoryId];
  return String(candidates.find((value) => String(value || "").trim()) || "").trim();
}

export class GraphRecallAgentToolset {
  constructor({ searchCandidates = null, authorizeMemoryIds = null } = {}) {
    this.searchCandidates =
      typeof searchCandidates === "function" ? searchCandidates : null;
    this.authorizeMemoryIds =
      typeof authorizeMemoryIds === "function" ? authorizeMemoryIds : null;
    this.workspaces = new Map();
  }

  openTask({
    runId,
    chatId,
    turnId,
    userMessage = "",
    recentMessages = [],
    graph,
    packet,
    signal = null,
  } = {}) {
    const key = String(runId || "").trim();
    if (!key || !graph || !packet) {
      throw new TypeError("Graph Recall Agent requires runId, graph, and packet");
    }
    const activeNodes = getActiveNodes(graph).filter(
      (node) => node && !node.archived && node.id,
    );
    this.workspaces.set(key, {
      runId: key,
      chatId: String(chatId || "").trim(),
      turnId: String(turnId || "").trim(),
      userMessage: String(userMessage || ""),
      recentMessages: (recentMessages || []).map((item) => String(item || "")),
      graph,
      packet,
      signal,
      nodesById: new Map(activeNodes.map((node) => [String(node.id), node])),
      outcome: { kind: "pending" },
    });
  }

  closeTask(runId) {
    const key = String(runId || "").trim();
    const workspace = this.workspaces.get(key) || null;
    this.workspaces.delete(key);
    return workspace?.outcome || null;
  }

  getOutcome(runId) {
    return cloneDomainValue(
      this.workspaces.get(String(runId || "").trim())?.outcome || {
        kind: "missing",
      },
      { kind: "missing" },
    );
  }

  _workspace(scope) {
    const workspace = this.workspaces.get(String(scope?.runId || "").trim());
    if (!workspace) throw new Error("Graph Recall Agent workspace is unavailable");
    if (scope?.signal?.aborted || workspace.signal?.aborted) {
      const error = new Error("Graph Recall Agent was cancelled");
      error.name = "AbortError";
      throw error;
    }
    return workspace;
  }

  async _authorizedMemoryIds(workspace, memoryIds = [], scope = null) {
    const requested = uniqueStrings(memoryIds).filter((memoryId) =>
      workspace.nodesById.has(memoryId),
    );
    if (!this.authorizeMemoryIds || requested.length === 0) return requested;
    const authorized = await this.authorizeMemoryIds({
      memoryIds: requested,
      graph: workspace.graph,
      packet: workspace.packet,
      signal: scope?.signal || workspace.signal,
    });
    const allowed = new Set(uniqueStrings(authorized));
    return requested.filter((memoryId) => allowed.has(memoryId));
  }

  registerInto(registry) {
    const dispose = [];
    dispose.push(
      registry.register(
        toolDefinition(
          "recall_context",
          "第一步使用。返回冻结的本轮输入、最近对话、快速候选、程序基线、剧情时间、场景人物 ownerKey 候选与向量状态。只读；不会启动新召回，也不会等待后台维护。",
        ),
        async (_args, scope) => await this.context(scope),
        { readOnly: true, idempotent: true },
      ),
    );
    dispose.push(
      registry.register(
        toolDefinition(
          "recall_search",
          "仅在快速候选存在明确缺口时搜索当前聊天的完整冻结图谱。返回经过作用域与认知边界过滤的候选；可按记忆类型、层级和 owner 缩小范围。不会修改图谱。",
          {
            query: { type: "string", minLength: 1, description: "面向语义检索的具体问题或线索。" },
            memoryTypes: stringArraySchema("可选的记忆类型过滤，例如 event、pov_memory、rule。"),
            layers: stringArraySchema("可选的记忆层过滤，例如 objective、pov、derived。"),
            ownerIds: stringArraySchema("可选的 POV owner 标识过滤。"),
            limit: { type: "integer", minimum: 1, maximum: 80 },
          },
          ["query"],
        ),
        async (args, scope) => await this.search(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    dispose.push(
      registry.register(
        toolDefinition(
          "recall_get",
          "按稳定 memoryId 读取当前冻结图谱中的真实节点字段、作用域、剧情时间、重要度与置信度。未知、归档或当前认知边界不可注入的 ID 会列入 missingMemoryIds。只读。",
          { memoryIds: stringArraySchema("只能使用召回工具已经返回的稳定 memoryId。") },
          ["memoryIds"],
        ),
        async (args, scope) => await this.get(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    dispose.push(
      registry.register(
        toolDefinition(
          "recall_neighbors",
          "沿一个已授权 memoryId 的当前图谱关系查找前因、后果、人物、地点或规则邻居。返回的关系与邻居同样经过注入边界过滤；只读，不代表邻居必须入选。",
          {
            memoryId: { type: "string", minLength: 1 },
            direction: { type: "string", enum: ["in", "out", "both"] },
            limit: { type: "integer", minimum: 1, maximum: 80 },
          },
          ["memoryId"],
        ),
        async (args, scope) => await this.neighbors(args, scope),
        { readOnly: true, idempotent: true },
      ),
    );
    dispose.push(
      registry.register(
        toolDefinition(
          "recall_publish",
          "本轮唯一结算工具。提交受验证的注入计划与场景人物集合：items 为空表示 Agent 不额外召回节点，不会触发 Workflow 召回；常驻 core 与历史摘要仍由程序规则决定。服务端只从真实图谱节点生成注入正文，item.reason 与总 reason 仅供审计。",
          {
            items: {
              type: "array",
              maxItems: 80,
              description: "按当前回复价值规划的记忆；同一 memoryId 只能出现一次。",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  memoryId: { type: "string", minLength: 1, maxLength: 256 },
                  role: {
                    type: "string",
                    enum: [...RECALL_INJECTION_ROLES],
                    description: "anchor=直接锚点；cause=前因后果；pov=主观认知；constraint=规则或承诺；background=少量背景。",
                  },
                  priority: {
                    type: "integer",
                    minimum: 1,
                    maximum: 5,
                    description: "同一安全作用域内的优先级，5 最高。",
                  },
                  reason: {
                    type: "string",
                    minLength: 1,
                    maxLength: 500,
                    description: "说明这条真实记忆对当前回复的具体作用；不进入注入正文。",
                  },
                },
                required: ["memoryId", "role", "priority", "reason"],
              },
            },
            activeOwnerKeys: stringArraySchema(
              "Scene owner keys selected from recall_context.sceneOwnerCandidates.",
            ),
            strategy: {
              type: "string",
              enum: [...RECALL_INJECTION_STRATEGIES],
              description: "focused=最小直接集；causal=因果链；pov=视角判断；timeline=时间连续；balanced=综合。",
            },
            reason: { type: "string", minLength: 1, maxLength: 1000 },
          },
          ["items", "activeOwnerKeys", "strategy", "reason"],
        ),
        async (args, scope) => await this.publish(args, scope),
        { idempotent: true },
      ),
    );
    return () => dispose.reverse().forEach((callback) => callback());
  }

  async context(scope) {
    const workspace = this._workspace(scope);
    return {
      chatId: workspace.chatId,
      turnId: workspace.turnId,
      userMessage: workspace.userMessage,
      recentMessages: workspace.recentMessages,
      candidates: cloneDomainValue(workspace.packet.candidates, []),
      baselineSelectedMemoryIds: cloneDomainValue(
        workspace.packet.initialSelectedMemoryIds,
        [],
      ),
      channels: cloneDomainValue(workspace.packet.channels, {}),
      vectorState: cloneDomainValue(workspace.packet.vectorState, {}),
      activeStoryTimeLabel: String(
        workspace.packet?.baseline?.scopeContext?.activeStoryTimeLabel || "",
      ),
      sceneOwnerCandidates: cloneDomainValue(
        workspace.packet?.baseline?.scopeContext?.sceneOwnerCandidates,
        [],
      ),
      baselineActiveOwnerKeys: cloneDomainValue(
        workspace.packet?.baseline?.scopeContext?.activeRecallOwnerKeys,
        [],
      ),
      activeMemoryCount: workspace.nodesById.size,
    };
  }

  async search(args = {}, scope) {
    const workspace = this._workspace(scope);
    if (!this.searchCandidates) {
      return { items: [], searchStatus: "unavailable" };
    }
    const result = await this.searchCandidates({
      ...args,
      graph: workspace.graph,
      signal: scope?.signal || workspace.signal,
    });
    const memoryTypes = new Set(uniqueStrings(args.memoryTypes));
    const layers = new Set(uniqueStrings(args.layers));
    const ownerIds = new Set(uniqueStrings(args.ownerIds));
    const limit = Math.max(1, Math.min(80, Math.floor(Number(args.limit) || 24)));
    const filteredItems = (result?.candidates || [])
      .filter((candidate) => {
        if (memoryTypes.size && !memoryTypes.has(String(candidate.memoryType || ""))) {
          return false;
        }
        if (layers.size && !layers.has(String(candidate.layer || ""))) return false;
        if (ownerIds.size) {
          const owners = uniqueStrings([
            candidate.scope?.ownerId,
            candidate.scope?.owner,
            candidate.scope?.characterId,
            candidate.scope?.character,
          ]);
          if (!owners.some((owner) => ownerIds.has(owner))) return false;
        }
        return true;
      });
    const authorizedIds = new Set(
      await this._authorizedMemoryIds(
        workspace,
        filteredItems.map((candidate) => candidate?.memoryId),
        scope,
      ),
    );
    const items = filteredItems
      .filter((candidate) =>
        authorizedIds.has(String(candidate?.memoryId || "")),
      )
      .slice(0, limit);
    return {
      query: String(args.query || ""),
      items,
      channels: cloneDomainValue(result?.channels, {}),
      searchStatus: "completed",
    };
  }

  async get({ memoryIds = [] } = {}, scope) {
    const workspace = this._workspace(scope);
    const requested = uniqueStrings(memoryIds);
    const authorized = new Set(
      await this._authorizedMemoryIds(workspace, requested, scope),
    );
    const items = requested
      .filter((memoryId) => authorized.has(memoryId))
      .map((memoryId) => projectNode(workspace.nodesById.get(memoryId)))
      .filter(Boolean);
    return {
      items,
      missingMemoryIds: requested.filter(
        (memoryId) => !authorized.has(memoryId),
      ),
    };
  }

  async neighbors(
    { memoryId = "", direction = "both", limit = 24 } = {},
    scope,
  ) {
    const workspace = this._workspace(scope);
    const sourceId = String(memoryId || "").trim();
    const [authorizedSourceId] = await this._authorizedMemoryIds(
      workspace,
      [sourceId],
      scope,
    );
    if (!authorizedSourceId) {
      return { memoryId: sourceId, missing: true, relations: [], neighbors: [] };
    }
    const relationRows = [];
    const neighborIds = [];
    for (const edge of workspace.graph.edges || []) {
      if (!edge || edge.archived) continue;
      const from = edgeEndpoint(edge, "from");
      const to = edgeEndpoint(edge, "to");
      const outgoing = from === sourceId;
      const incoming = to === sourceId;
      if (
        !(
          (direction === "out" && outgoing) ||
          (direction === "in" && incoming) ||
          (direction === "both" && (outgoing || incoming))
        )
      ) {
        continue;
      }
      relationRows.push({
        id: String(edge.id || ""),
        from,
        to,
        relation: String(edge.relation || edge.type || edge.label || ""),
        strength: Number(edge.strength ?? edge.weight ?? 0),
      });
      neighborIds.push(outgoing ? to : from);
      if (relationRows.length >= Math.max(1, Math.min(80, Number(limit) || 24))) {
        break;
      }
    }
    const authorizedNeighborIds = new Set(
      await this._authorizedMemoryIds(workspace, neighborIds, scope),
    );
    const visibleRelations = relationRows.filter((row) => {
      const neighborId = row.from === sourceId ? row.to : row.from;
      return authorizedNeighborIds.has(neighborId);
    });
    return {
      memoryId: sourceId,
      relations: visibleRelations,
      neighbors: uniqueStrings(neighborIds)
        .filter((id) => authorizedNeighborIds.has(id))
        .map((id) => projectNode(workspace.nodesById.get(id)))
        .filter(Boolean),
    };
  }

  async publish(
    { items = [], activeOwnerKeys = [], strategy = "balanced", reason = "" } = {},
    scope,
  ) {
    const workspace = this._workspace(scope);
    if (workspace.outcome.kind === "published") {
      return cloneDomainValue(workspace.outcome, workspace.outcome);
    }
    const normalizedPlan = normalizeRecallInjectionPlan({ items, strategy });
    if (!normalizedPlan.valid) {
      return {
        published: false,
        invalidSelection: true,
        planIssues: normalizedPlan.issues,
        instruction: "Fix the injection plan and call recall_publish again.",
      };
    }
    const selected = normalizedPlan.plan.items.map((item) => item.memoryId);
    const authorized = new Set(
      await this._authorizedMemoryIds(workspace, selected, scope),
    );
    const missingMemoryIds = selected.filter(
      (memoryId) => !authorized.has(memoryId),
    );
    if (missingMemoryIds.length) {
      return {
        published: false,
        invalidSelection: true,
        missingMemoryIds,
        instruction: "Use stable memoryId values returned by recall tools.",
      };
    }
    const availableOwnerKeys = new Set(
      uniqueStrings(
        (
          workspace.packet?.baseline?.scopeContext?.sceneOwnerCandidates || []
        ).map((candidate) => candidate?.ownerKey),
      ),
    );
    const selectedOwnerKeys = uniqueStrings(activeOwnerKeys);
    const missingOwnerKeys = selectedOwnerKeys.filter(
      (ownerKey) => !availableOwnerKeys.has(ownerKey),
    );
    if (missingOwnerKeys.length) {
      return {
        published: false,
        invalidSelection: true,
        missingOwnerKeys,
        instruction:
          "Use ownerKey values returned by recall_context.sceneOwnerCandidates.",
      };
    }
    workspace.outcome = {
      kind: "published",
      published: true,
      selectedMemoryIds: selected,
      activeOwnerKeys: selectedOwnerKeys,
      injectionPlan: normalizedPlan.plan,
      reason: String(reason || "").trim(),
    };
    return cloneDomainValue(workspace.outcome, workspace.outcome);
  }
}
