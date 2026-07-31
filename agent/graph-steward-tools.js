import { cloneDomainValue } from "../domain/memory-id.js";

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

const CAPABILITY_KEYS = Object.freeze({
  consolidate: "enableConsolidation",
  summarize: "enableHierarchicalSummary",
  reflect: "enableReflection",
  compress: "enableAutoCompression",
  forget: "enableSleepCycle",
});

export function resolveGraphStewardCapabilitySelection(
  requested = {},
  allowed = {},
) {
  const selected = {};
  for (const [name, settingKey] of Object.entries(CAPABILITY_KEYS)) {
    selected[name] = allowed[name] === true && requested[name] === true;
    selected[settingKey] = selected[name];
  }
  selected.enableSynopsis = selected.summarize;
  return selected;
}

export class GraphStewardAgentToolset {
  constructor({ runPipeline, completeWithoutChanges } = {}) {
    if (typeof runPipeline !== "function") {
      throw new TypeError("Graph Steward requires runPipeline");
    }
    if (typeof completeWithoutChanges !== "function") {
      throw new TypeError("Graph Steward requires completeWithoutChanges");
    }
    this.runPipeline = runPipeline;
    this.completeWithoutChanges = completeWithoutChanges;
    this.workspaces = new Map();
  }

  openTask({ runId, context, allowedCapabilities = {} } = {}) {
    const key = String(runId || "").trim();
    if (!key) throw new TypeError("Graph Steward task requires runId");
    this.workspaces.set(key, {
      context: cloneDomainValue(context, {}),
      allowedCapabilities: cloneDomainValue(allowedCapabilities, {}),
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
    if (!workspace) throw new Error("Graph Steward workspace is unavailable");
    if (scope?.signal?.aborted) {
      const error = new Error("Graph Steward was cancelled");
      error.name = "AbortError";
      throw error;
    }
    return workspace;
  }

  registerInto(registry) {
    const dispose = [];
    dispose.push(
      registry.register(
        toolDefinition(
          "memory_task_context",
          "第一步使用。返回完整未处理聊天批次、标记为 contextOnly 的理解性前文、图谱/总结/维护统计，以及用户本轮允许的维护能力。只读；返回内容是本次判断的事实边界。",
        ),
        async (_args, scope) => await this.context(scope),
        { readOnly: true, idempotent: true },
      ),
    );
    dispose.push(
      registry.register(
        toolDefinition(
          "memory_run_pipeline",
          "本批次的有变更结算工具。始终执行受事务保护的客观/主观提取与持久化，并按需附加整合、总结、反思、压缩、遗忘；请求只能缩小用户已允许的能力，不能开启禁用项。成功或失败后都不能再改用无变更结算。",
          {
            consolidate: { type: "boolean" },
            summarize: { type: "boolean" },
            reflect: { type: "boolean" },
            compress: { type: "boolean" },
            forget: { type: "boolean" },
            reason: { type: "string", minLength: 1 },
          },
          [
            "consolidate",
            "summarize",
            "reflect",
            "compress",
            "forget",
            "reason",
          ],
        ),
        async (args, scope) => await this.pipeline(args, scope),
        { idempotent: true },
      ),
    );
    dispose.push(
      registry.register(
        toolDefinition(
          "memory_complete_without_changes",
          "本批次的无变更结算工具。仅在新批次没有长期记忆价值且所有已允许维护工作都无需运行时使用；会建立可回退的已处理检查点，不创建记忆。成功或失败后都不能再启动管线。",
          { reason: { type: "string", minLength: 1 } },
          ["reason"],
        ),
        async (args, scope) => await this.noChange(args, scope),
        { idempotent: true },
      ),
    );
    return () => dispose.reverse().forEach((callback) => callback());
  }

  async context(scope) {
    const workspace = this._workspace(scope);
    return {
      ...cloneDomainValue(workspace.context, {}),
      allowedCapabilities: cloneDomainValue(
        workspace.allowedCapabilities,
        {},
      ),
    };
  }

  async pipeline(requested = {}, scope) {
    const workspace = this._workspace(scope);
    if (workspace.outcome.kind !== "pending") {
      return cloneDomainValue(workspace.outcome, workspace.outcome);
    }
    const capabilities = resolveGraphStewardCapabilitySelection(
      requested,
      workspace.allowedCapabilities,
    );
    const reason = String(requested.reason || "").trim();
    workspace.outcome = {
      kind: "pipeline_attempting",
      completed: false,
      capabilities,
      reason,
    };
    try {
      const result = await this.runPipeline({
        capabilities,
        reason,
        signal: scope?.signal,
      });
      const success = result?.success === true;
      workspace.outcome = {
        kind: success ? "pipeline" : "pipeline_failed",
        completed: success,
        capabilities,
        reason,
        result: cloneDomainValue(result, {}),
      };
      if (!success) {
        throw new Error(
          String(result?.error || result?.reason || "Graph Steward pipeline failed"),
        );
      }
      return cloneDomainValue(workspace.outcome, workspace.outcome);
    } catch (error) {
      if (workspace.outcome.kind === "pipeline_attempting") {
        workspace.outcome = {
          ...workspace.outcome,
          kind: "pipeline_failed",
          error: error?.message || String(error),
        };
      }
      throw error;
    }
  }

  async noChange({ reason = "" } = {}, scope) {
    const workspace = this._workspace(scope);
    if (workspace.outcome.kind !== "pending") {
      return cloneDomainValue(workspace.outcome, workspace.outcome);
    }
    const normalizedReason = String(reason || "").trim();
    workspace.outcome = {
      kind: "no_change_attempting",
      completed: false,
      reason: normalizedReason,
    };
    try {
      const result = await this.completeWithoutChanges({
        reason: normalizedReason,
        signal: scope?.signal,
      });
      const success = result?.success === true;
      workspace.outcome = {
        kind: success ? "no_change" : "no_change_failed",
        completed: success,
        reason: normalizedReason,
        result: cloneDomainValue(result, {}),
      };
      if (!success) {
        throw new Error(
          String(result?.error || result?.reason || "Graph Steward checkpoint failed"),
        );
      }
      return cloneDomainValue(workspace.outcome, workspace.outcome);
    } catch (error) {
      if (workspace.outcome.kind === "no_change_attempting") {
        workspace.outcome = {
          ...workspace.outcome,
          kind: "no_change_failed",
          error: error?.message || String(error),
        };
      }
      throw error;
    }
  }
}
