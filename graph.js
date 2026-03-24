// ST-BME: 图数据模型
// 管理节点、边的 CRUD 操作，以及序列化到 chat_metadata

import {
  createDefaultBatchJournal,
  createDefaultHistoryState,
  createDefaultVectorIndexState,
  normalizeGraphRuntimeState,
} from "./runtime-state.js";

/**
 * 图状态版本号
 */
const GRAPH_VERSION = 4;

/**
 * 生成 UUID v4
 */
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 创建空的图状态
 * @returns {GraphState}
 */
export function createEmptyGraph() {
  return normalizeGraphRuntimeState({
    version: GRAPH_VERSION,
    lastProcessedSeq: -1,
    nodes: [],
    edges: [],
    lastRecallResult: null,
    historyState: createDefaultHistoryState(),
    vectorIndexState: createDefaultVectorIndexState(),
    batchJournal: createDefaultBatchJournal(),
  });
}

// ==================== 节点操作 ====================

/**
 * 创建新节点
 * @param {object} params
 * @returns {object} 新节点
 */
export function createNode({
  type,
  fields = {},
  seq = 0,
  seqRange = null,
  importance = 5.0,
  clusters = [],
}) {
  const now = Date.now();
  return {
    id: uuid(),
    type,
    level: 0,
    parentId: null,
    childIds: [],
    seq,
    seqRange: seqRange || [seq, seq],
    archived: false,
    fields,
    embedding: null,
    importance: Math.max(0, Math.min(10, importance)),
    accessCount: 0,
    lastAccessTime: now,
    createdTime: now,
    prevId: null,
    nextId: null,
    clusters,
  };
}

/**
 * 在图中添加节点
 * @param {GraphState} graph
 * @param {object} node
 * @returns {object} 添加的节点
 */
export function addNode(graph, node) {
  // 同类型节点的时间链表：连接到最后一个同类型节点
  const sameTypeNodes = graph.nodes
    .filter((n) => n.type === node.type && !n.archived && n.level === 0)
    .sort((a, b) => a.seq - b.seq);

  if (sameTypeNodes.length > 0) {
    const lastNode = sameTypeNodes[sameTypeNodes.length - 1];
    lastNode.nextId = node.id;
    node.prevId = lastNode.id;
  }

  graph.nodes.push(node);
  return node;
}

/**
 * 根据 ID 获取节点
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {object|null}
 */
export function getNode(graph, nodeId) {
  return graph.nodes.find((n) => n.id === nodeId) || null;
}

/**
 * 更新节点字段（部分更新）
 * @param {GraphState} graph
 * @param {string} nodeId
 * @param {object} updates - 要更新的字段
 * @returns {boolean} 是否找到并更新
 */
export function updateNode(graph, nodeId, updates) {
  const node = getNode(graph, nodeId);
  if (!node) return false;

  if (updates.fields) {
    node.fields = { ...node.fields, ...updates.fields };
    delete updates.fields;
  }

  Object.assign(node, updates);
  return true;
}

/**
 * 删除节点及其相关边
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {boolean}
 */
export function removeNode(graph, nodeId) {
  const node = getNode(graph, nodeId);
  if (!node) return false;

  // 修复时间链表
  if (node.prevId) {
    const prev = getNode(graph, node.prevId);
    if (prev) prev.nextId = node.nextId;
  }
  if (node.nextId) {
    const next = getNode(graph, node.nextId);
    if (next) next.prevId = node.prevId;
  }

  // 递归删除子节点
  for (const childId of node.childIds) {
    removeNode(graph, childId);
  }

  // 从父节点中移除引用
  if (node.parentId) {
    const parent = getNode(graph, node.parentId);
    if (parent) {
      parent.childIds = parent.childIds.filter((id) => id !== nodeId);
    }
  }

  // 删除相关边
  graph.edges = graph.edges.filter(
    (e) => e.fromId !== nodeId && e.toId !== nodeId,
  );

  // 删除节点本身
  graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);

  return true;
}

/**
 * 获取所有未归档的节点
 * @param {GraphState} graph
 * @param {string} [typeFilter] - 可选类型过滤
 * @returns {object[]}
 */
export function getActiveNodes(graph, typeFilter = null) {
  let nodes = graph.nodes.filter((n) => !n.archived);
  if (typeFilter) {
    nodes = nodes.filter((n) => n.type === typeFilter);
  }
  return nodes;
}

/**
 * 按类型查找最新版本的节点（用于 latestOnly 类型）
 * @param {GraphState} graph
 * @param {string} type
 * @param {string} primaryKeyValue - 主键值（如角色名）
 * @param {string} primaryKeyField - 主键字段名（默认 'name'）
 * @returns {object|null}
 */
export function findLatestNode(
  graph,
  type,
  primaryKeyValue,
  primaryKeyField = "name",
) {
  const candidates = graph.nodes.filter(
    (n) =>
      n.type === type &&
      !n.archived &&
      n.fields[primaryKeyField] === primaryKeyValue,
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.seq - a.seq)[0];
}

// ==================== 边操作 ====================

/**
 * 创建边
 * @param {object} params
 * @returns {object} 新边
 */
export function createEdge({
  fromId,
  toId,
  relation = "related",
  strength = 0.8,
  edgeType = 0,
}) {
  return {
    id: uuid(),
    fromId,
    toId,
    relation,
    strength: Math.max(0, Math.min(1, strength)),
    edgeType,
    createdTime: Date.now(),
    // Graphiti 启发的时序字段
    validAt: Date.now(), // 关系生效时间
    invalidAt: null, // 关系失效时间（null = 当前有效）
    expiredAt: null, // 系统标记过期时间
  };
}

/**
 * 在图中添加边（检查节点存在性）
 * @param {GraphState} graph
 * @param {object} edge
 * @returns {object|null} 添加的边或 null
 */
export function addEdge(graph, edge) {
  const from = getNode(graph, edge.fromId);
  const to = getNode(graph, edge.toId);
  if (!from || !to) return null;
  if (edge.fromId === edge.toId) return null;

  const isCurrentEdgeValid = (candidate) => {
    if (candidate.invalidAt) return false;
    if (candidate.expiredAt) return false;
    return true;
  };

  // 对当前有效边去重；历史边保留，避免历史污染当前检索
  const existing = graph.edges.find(
    (e) =>
      e.fromId === edge.fromId &&
      e.toId === edge.toId &&
      e.relation === edge.relation &&
      isCurrentEdgeValid(e),
  );
  if (existing) {
    existing.strength = Math.max(existing.strength, edge.strength ?? 0);
    existing.validAt = Math.max(
      existing.validAt || 0,
      edge.validAt || Date.now(),
    );
    if (edge.invalidAt) {
      existing.invalidAt = edge.invalidAt;
    }
    if (edge.expiredAt) {
      existing.expiredAt = edge.expiredAt;
    }
    return existing;
  }

  graph.edges.push(edge);
  return edge;
}

/**
 * 移除边
 * @param {GraphState} graph
 * @param {string} edgeId
 * @returns {boolean}
 */
export function removeEdge(graph, edgeId) {
  const idx = graph.edges.findIndex((e) => e.id === edgeId);
  if (idx === -1) return false;
  graph.edges.splice(idx, 1);
  return true;
}

/**
 * 获取节点的所有出边
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {object[]}
 */
export function getOutEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.fromId === nodeId);
}

/**
 * 获取节点的所有入边
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {object[]}
 */
export function getInEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.toId === nodeId);
}

/**
 * 获取连接到节点的所有边（入+出）
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {object[]}
 */
export function getNodeEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.fromId === nodeId || e.toId === nodeId);
}

// ==================== 查询辅助 ====================

/**
 * 构建邻接表（用于扩散引擎）
 * @param {GraphState} graph
 * @returns {Map<string, Array<{targetId: string, strength: number, edgeType: number}>>}
 */
export function buildAdjacencyMap(graph) {
  const adj = new Map();
  const activeNodeIds = new Set(
    graph.nodes.filter((node) => !node.archived).map((node) => node.id),
  );

  for (const edge of graph.edges) {
    if (!isEdgeActive(edge)) continue;
    if (!activeNodeIds.has(edge.fromId) || !activeNodeIds.has(edge.toId)) {
      continue;
    }

    if (!adj.has(edge.fromId)) adj.set(edge.fromId, []);
    adj.get(edge.fromId).push({
      targetId: edge.toId,
      strength: edge.strength,
      edgeType: edge.edgeType,
    });

    if (!adj.has(edge.toId)) adj.set(edge.toId, []);
    adj.get(edge.toId).push({
      targetId: edge.fromId,
      strength: edge.strength,
      edgeType: edge.edgeType,
    });
  }

  return adj;
}

/**
 * 构建时序感知邻接表（过滤失效边）
 * Graphiti 启发：只纳入 "当前有效" 的边
 * @param {GraphState} graph
 * @returns {Map}
 */
export function buildTemporalAdjacencyMap(graph) {
  const adj = new Map();
  const activeNodeIds = new Set(
    graph.nodes.filter((node) => !node.archived).map((node) => node.id),
  );

  for (const edge of graph.edges) {
    if (!isEdgeActive(edge)) continue;
    if (!activeNodeIds.has(edge.fromId) || !activeNodeIds.has(edge.toId)) {
      continue;
    }

    if (!adj.has(edge.fromId)) adj.set(edge.fromId, []);
    adj.get(edge.fromId).push({
      targetId: edge.toId,
      strength: edge.strength,
      edgeType: edge.edgeType,
    });

    if (!adj.has(edge.toId)) adj.set(edge.toId, []);
    adj.get(edge.toId).push({
      targetId: edge.fromId,
      strength: edge.strength,
      edgeType: edge.edgeType,
    });
  }

  return adj;
}

function isEdgeActive(edge, now = Date.now()) {
  if (!edge) return false;
  if (edge.invalidAt && edge.invalidAt <= now) return false;
  if (edge.expiredAt && edge.expiredAt <= now) return false;
  return true;
}

/**
 * 将边标记为失效（不删除，保留历史）
 * @param {object} edge
 */
export function invalidateEdge(edge) {
  if (!edge) return;
  if (!edge.invalidAt) {
    edge.invalidAt = Date.now();
  }
}

/**
 * 获取图的统计信息
 * @param {GraphState} graph
 * @returns {object}
 */
export function getGraphStats(graph) {
  const activeNodes = graph.nodes.filter((n) => !n.archived);
  const archivedNodes = graph.nodes.filter((n) => n.archived);
  const typeCounts = {};
  for (const node of activeNodes) {
    typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
  }

  return {
    totalNodes: graph.nodes.length,
    activeNodes: activeNodes.length,
    archivedNodes: archivedNodes.length,
    totalEdges: graph.edges.length,
    lastProcessedSeq: graph.lastProcessedSeq,
    typeCounts,
  };
}

// ==================== 序列化 ====================

/**
 * 序列化图状态为 JSON 字符串
 * @param {GraphState} graph
 * @returns {string}
 */
export function serializeGraph(graph) {
  return JSON.stringify(graph);
}

/**
 * 从 JSON 反序列化图状态
 * @param {string} json
 * @returns {GraphState}
 */
export function deserializeGraph(json) {
  try {
    const data = typeof json === "string" ? JSON.parse(json) : json;

    if (!data || data.version === undefined) {
      return createEmptyGraph();
    }

    if (data.version < GRAPH_VERSION) {
      console.log(`[ST-BME] 图版本迁移 v${data.version} → v${GRAPH_VERSION}`);

      if (data.version < 2 && data.edges) {
        for (const edge of data.edges) {
          if (edge.validAt === undefined)
            edge.validAt = edge.createdTime || Date.now();
          if (edge.invalidAt === undefined) edge.invalidAt = null;
          if (edge.expiredAt === undefined) edge.expiredAt = null;
        }
      }

      if (data.version < 3) {
        if (typeof data.lastProcessedSeq !== "number") {
          data.lastProcessedSeq = -1;
        }
        for (const node of data.nodes || []) {
          if (!Array.isArray(node.seqRange)) {
            const seq = Number.isFinite(node.seq) ? node.seq : 0;
            node.seqRange = [seq, seq];
          }
        }
      }

      if (data.version < 4) {
        data.historyState = {
          ...createDefaultHistoryState(),
          ...(data.historyState || {}),
          lastProcessedAssistantFloor: Number.isFinite(data.lastProcessedSeq)
            ? data.lastProcessedSeq
            : -1,
        };
        data.vectorIndexState = {
          ...createDefaultVectorIndexState(),
          ...(data.vectorIndexState || {}),
          dirty: true,
          lastWarning: "旧版本图谱已迁移，需要重建向量运行时状态",
        };
        data.batchJournal = Array.isArray(data.batchJournal)
          ? data.batchJournal
          : createDefaultBatchJournal();
      }

      data.version = GRAPH_VERSION;
    }

    data.nodes = (data.nodes || []).map((node) => {
      const seq = Number.isFinite(node.seq) ? node.seq : 0;
      return {
        level: 0,
        parentId: null,
        childIds: [],
        accessCount: 0,
        lastAccessTime: node.createdTime || Date.now(),
        prevId: null,
        nextId: null,
        clusters: [],
        ...node,
        seq,
        seqRange: Array.isArray(node.seqRange) ? node.seqRange : [seq, seq],
      };
    });
    data.edges = (data.edges || []).map((edge) => ({
      createdTime: Date.now(),
      validAt: edge?.createdTime || Date.now(),
      invalidAt: null,
      expiredAt: null,
      ...edge,
    }));
    data.lastProcessedSeq = Number.isFinite(data.lastProcessedSeq)
      ? data.lastProcessedSeq
      : -1;
    data.lastRecallResult = Array.isArray(data.lastRecallResult)
      ? data.lastRecallResult
      : null;
    data.historyState = {
      ...createDefaultHistoryState(),
      ...(data.historyState || {}),
      lastProcessedAssistantFloor: Number.isFinite(
        data?.historyState?.lastProcessedAssistantFloor,
      )
        ? data.historyState.lastProcessedAssistantFloor
        : data.lastProcessedSeq,
    };
    data.vectorIndexState = {
      ...createDefaultVectorIndexState(data?.historyState?.chatId || ""),
      ...(data.vectorIndexState || {}),
    };
    data.batchJournal = Array.isArray(data.batchJournal)
      ? data.batchJournal
      : createDefaultBatchJournal();

    return normalizeGraphRuntimeState(data, data?.historyState?.chatId || "");
  } catch (e) {
    console.error("[ST-BME] 图反序列化失败:", e);
    return createEmptyGraph();
  }
}

/**
 * 导出图数据（不含 embedding 以减小体积）
 * @param {GraphState} graph
 * @returns {string} JSON 字符串
 */
export function exportGraph(graph) {
  const exportData = {
    ...graph,
    historyState: {
      ...createDefaultHistoryState(graph?.historyState?.chatId || ""),
      lastProcessedAssistantFloor:
        graph?.historyState?.lastProcessedAssistantFloor ?? graph?.lastProcessedSeq ?? -1,
    },
    vectorIndexState: {
      ...createDefaultVectorIndexState(graph?.historyState?.chatId || ""),
      dirty: true,
      lastWarning: "导出图谱不包含运行时向量索引",
    },
    batchJournal: createDefaultBatchJournal(),
    nodes: graph.nodes.map((n) => ({ ...n, embedding: null })),
  };
  return JSON.stringify(exportData, null, 2);
}

/**
 * 导入图数据
 * @param {string} json
 * @returns {GraphState}
 */
export function importGraph(json) {
  const graph = normalizeGraphRuntimeState(deserializeGraph(json));
  // 导入的节点需要重新生成 embedding
  for (const node of graph.nodes) {
    node.embedding = null;
  }
  graph.batchJournal = createDefaultBatchJournal();
  graph.historyState.processedMessageHashes = {};
  graph.historyState.historyDirtyFrom = null;
  graph.vectorIndexState.hashToNodeId = {};
  graph.vectorIndexState.nodeToHash = {};
  graph.vectorIndexState.dirty = true;
  graph.vectorIndexState.lastWarning = "导入图谱后需要重建向量索引";
  return graph;
}
