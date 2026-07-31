import { cloneDomainValue } from "../domain/memory-id.js";
import { getActiveNodes } from "../graph/graph.js";

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
          "Read the frozen turn, deterministic first-recollection candidates, vector state, and baseline selection.",
        ),
        async (_args, scope) => await this.context(scope),
        { readOnly: true, idempotent: true },
      ),
    );
    dispose.push(
      registry.register(
        toolDefinition(
          "recall_search",
          "Search the full current chat memory graph when the initial candidates are insufficient.",
          {
            query: { type: "string", minLength: 1 },
            memoryTypes: stringArraySchema(),
            layers: stringArraySchema(),
            ownerIds: stringArraySchema(),
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
          "Read exact active graph nodes by stable memoryId.",
          { memoryIds: stringArraySchema() },
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
          "Traverse current graph relations around one stable memoryId.",
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
          "Publish exactly one validated selection for this turn. An empty selection is valid.",
          {
            selectedMemoryIds: stringArraySchema(),
            reason: { type: "string" },
          },
          ["selectedMemoryIds"],
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

  async publish({ selectedMemoryIds = [], reason = "" } = {}, scope) {
    const workspace = this._workspace(scope);
    if (workspace.outcome.kind === "published") {
      return cloneDomainValue(workspace.outcome, workspace.outcome);
    }
    const selected = uniqueStrings(selectedMemoryIds);
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
    workspace.outcome = {
      kind: "published",
      published: true,
      selectedMemoryIds: selected,
      reason: String(reason || "").trim(),
    };
    return cloneDomainValue(workspace.outcome, workspace.outcome);
  }
}
