import { GraphRenderer } from "../../ui/graph-renderer.js";

function element(document, id) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`missing BME panel element: ${id}`);
  return value;
}

function errorText(error) {
  return String(error?.message || error || "unknown error");
}

function downloadText(document, name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function panelMarkup() {
  return `
    <button id="st-bme-v9-open" class="st-bme-v9-fab" type="button" aria-label="打开 BME 记忆面板">
      <i class="fa-solid fa-brain" aria-hidden="true"></i>
    </button>
    <div id="st-bme-v9-overlay" class="st-bme-v9-overlay" hidden>
      <section id="st-bme-v9-panel" class="st-bme-v9-panel" role="dialog" aria-modal="true" aria-labelledby="st-bme-v9-title">
        <header class="st-bme-v9-header">
          <div>
            <h2 id="st-bme-v9-title">Bionic Memory Ecology v9</h2>
            <p id="st-bme-v9-status" class="st-bme-v9-status">正在启动</p>
          </div>
          <button id="st-bme-v9-close" type="button" aria-label="关闭">×</button>
        </header>
        <nav class="st-bme-v9-tabs" aria-label="BME 面板">
          <button type="button" data-bme-tab="overview" aria-selected="true">总览</button>
          <button type="button" data-bme-tab="graph">图谱</button>
          <button type="button" data-bme-tab="records">事务记录</button>
          <button type="button" data-bme-tab="settings">设置</button>
        </nav>

        <main class="st-bme-v9-content">
          <section data-bme-page="overview">
            <div class="st-bme-v9-actions">
              <button id="st-bme-v9-refresh" type="button">刷新</button>
              <button id="st-bme-v9-extract" type="button">提取最新回复</button>
              <button id="st-bme-v9-vector" type="button">重建向量</button>
              <button id="st-bme-v9-export" type="button">导出图谱</button>
              <label class="st-bme-v9-file">导入图谱<input id="st-bme-v9-import" type="file" accept="application/json,.json"></label>
              <button id="st-bme-v9-clear" class="danger" type="button">清空图谱</button>
            </div>
            <dl id="st-bme-v9-summary" class="st-bme-v9-summary"></dl>
            <pre id="st-bme-v9-operation" class="st-bme-v9-operation" aria-live="polite"></pre>
          </section>

          <section data-bme-page="graph" hidden>
            <div class="st-bme-v9-graph-shell"><canvas id="st-bme-v9-canvas"></canvas></div>
            <form id="st-bme-v9-node-form" class="st-bme-v9-node-editor" hidden>
              <h3>节点 <code id="st-bme-v9-node-id"></code></h3>
              <label>重要度 <input id="st-bme-v9-node-importance" type="number" min="0" max="10" step="0.1"></label>
              <label><input id="st-bme-v9-node-archived" type="checkbox"> 已归档</label>
              <label>字段 JSON<textarea id="st-bme-v9-node-fields" rows="9" spellcheck="false"></textarea></label>
              <div class="st-bme-v9-actions">
                <button type="submit">保存节点</button>
                <button id="st-bme-v9-node-delete" class="danger" type="button">删除节点</button>
              </div>
            </form>
          </section>

          <section data-bme-page="records" hidden>
            <h3>RecallRecord</h3>
            <pre id="st-bme-v9-recalls"></pre>
            <h3>PlannerRecord</h3>
            <pre id="st-bme-v9-planners"></pre>
            <h3>VectorJob</h3>
            <pre id="st-bme-v9-jobs"></pre>
          </section>

          <section data-bme-page="settings" hidden>
            <form id="st-bme-v9-settings-form" class="st-bme-v9-settings">
              <fieldset>
                <legend>运行边界</legend>
                <label><input id="st-bme-v9-enabled" type="checkbox"> 启用 BME（变更后刷新页面）</label>
                <label>Primary
                  <select id="st-bme-v9-primary">
                    <option value="indexeddb">IndexedDB</option>
                    <option value="authority">Authority</option>
                  </select>
                  <small>只在页面启动时选定；不可热切换、不可回落。</small>
                </label>
                <label>Authority 地址 <input id="st-bme-v9-authority-url" type="text"></label>
              </fieldset>
              <fieldset>
                <legend>剧情与记忆</legend>
                <label><input id="st-bme-v9-ena" type="checkbox"> 显式启用 ENA 剧情规划</label>
                <label><input id="st-bme-v9-auto-extract" type="checkbox"> 自动提取助手回复</label>
                <label><input id="st-bme-v9-recall" type="checkbox"> 普通 user 层召回</label>
                <label>提取间隔 <input id="st-bme-v9-extract-every" type="number" min="1" max="50"></label>
                <label>召回节点上限 <input id="st-bme-v9-recall-max" type="number" min="1" max="500"></label>
              </fieldset>
              <fieldset>
                <legend>Embedding</legend>
                <label>传输
                  <select id="st-bme-v9-embedding-mode">
                    <option value="direct">直连 API</option>
                    <option value="backend">ST 后端</option>
                  </select>
                </label>
                <label>API 地址 <input id="st-bme-v9-embedding-url" type="text"></label>
                <label>API Key <input id="st-bme-v9-embedding-key" type="password" autocomplete="off"></label>
                <label>模型 <input id="st-bme-v9-embedding-model" type="text"></label>
              </fieldset>
              <fieldset>
                <legend>任务配置</legend>
                <label>Task Profiles JSON<textarea id="st-bme-v9-profiles" rows="12" spellcheck="false"></textarea></label>
                <label>Global Regex JSON<textarea id="st-bme-v9-regex" rows="8" spellcheck="false"></textarea></label>
              </fieldset>
              <button type="submit">保存设置</button>
              <p id="st-bme-v9-settings-note" aria-live="polite"></p>
            </form>
          </section>
        </main>
      </section>
    </div>`;
}

export function mountPanel(runtime, { documentLike = globalThis.document } = {}) {
  if (!runtime?.snapshot || !runtime?.saveSettings) throw new TypeError("BME runtime is required");
  const document = documentLike;
  if (!document?.body) throw new Error("document body is unavailable");
  if (document.getElementById("st-bme-v9-overlay")) return () => {};

  const mount = document.createElement("div");
  mount.id = "st-bme-v9-root";
  mount.innerHTML = panelMarkup();
  document.body.appendChild(mount);

  const overlay = element(document, "st-bme-v9-overlay");
  const openButton = element(document, "st-bme-v9-open");
  const closeButton = element(document, "st-bme-v9-close");
  const statusLine = element(document, "st-bme-v9-status");
  const operation = element(document, "st-bme-v9-operation");
  const nodeForm = element(document, "st-bme-v9-node-form");
  const canvas = element(document, "st-bme-v9-canvas");
  let latest = null;
  let selectedNode = null;

  const renderer = new GraphRenderer(canvas, {
    theme: runtime.getSettings().panelTheme,
    onNodeClick: (node) => {
      selectedNode = node?.raw || null;
      nodeForm.hidden = !selectedNode;
      if (!selectedNode) return;
      element(document, "st-bme-v9-node-id").textContent = selectedNode.id;
      element(document, "st-bme-v9-node-importance").value = String(selectedNode.importance ?? 5);
      element(document, "st-bme-v9-node-archived").checked = selectedNode.archived === true;
      element(document, "st-bme-v9-node-fields").value = JSON.stringify(selectedNode.fields || {}, null, 2);
    },
  });

  const showOperation = (value, failed = false) => {
    operation.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    operation.dataset.failed = String(failed);
  };

  const renderStatus = (status) => {
    const error = status.error ? ` · ${errorText(status.error)}` : "";
    statusLine.textContent = `${status.activePrimary} · ${status.availability} · ${status.activity}${error}`;
    statusLine.dataset.availability = status.availability;
  };

  const fillSettings = (settings) => {
    element(document, "st-bme-v9-enabled").checked = settings.enabled;
    element(document, "st-bme-v9-primary").value = settings.primary;
    element(document, "st-bme-v9-authority-url").value = settings.authorityBaseUrl;
    element(document, "st-bme-v9-ena").checked = settings.ena.enabled;
    element(document, "st-bme-v9-auto-extract").checked = settings.extractAutoEnabled;
    element(document, "st-bme-v9-recall").checked = settings.recallEnabled;
    element(document, "st-bme-v9-extract-every").value = String(settings.extractEvery);
    element(document, "st-bme-v9-recall-max").value = String(settings.recallMaxNodes);
    element(document, "st-bme-v9-embedding-mode").value = settings.embeddingTransportMode;
    element(document, "st-bme-v9-embedding-url").value = settings.embeddingApiUrl;
    element(document, "st-bme-v9-embedding-key").value = settings.embeddingApiKey;
    element(document, "st-bme-v9-embedding-model").value = settings.embeddingModel;
    element(document, "st-bme-v9-profiles").value = JSON.stringify(settings.taskProfiles, null, 2);
    element(document, "st-bme-v9-regex").value = JSON.stringify(settings.globalTaskRegex, null, 2);
  };

  fillSettings(runtime.getSettings());

  const renderSnapshot = (snapshot) => {
    latest = snapshot;
    renderStatus(snapshot.status);
    element(document, "st-bme-v9-summary").innerHTML = "";
    const summary = element(document, "st-bme-v9-summary");
    for (const [label, value] of [
      ["聊天", snapshot.chatKey],
      ["修订", `${snapshot.head.revision} / graph ${snapshot.head.graphRevision}`],
      ["处理至", snapshot.head.processedThrough],
      ["节点", snapshot.graph.nodes.length],
      ["边", snapshot.graph.edges.length],
      ["RecallRecord", snapshot.recallRecords.length],
      ["PlannerRecord", snapshot.plannerRecords.length],
    ]) {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = String(value);
      summary.append(dt, dd);
    }
    renderer.loadGraph(snapshot.graph);
    element(document, "st-bme-v9-recalls").textContent = JSON.stringify(snapshot.recallRecords, null, 2);
    element(document, "st-bme-v9-planners").textContent = JSON.stringify(snapshot.plannerRecords, null, 2);
    element(document, "st-bme-v9-jobs").textContent = JSON.stringify(snapshot.vectorJobs, null, 2);
    fillSettings(snapshot.settings);
  };

  const refresh = async () => {
    try {
      renderSnapshot(await runtime.snapshot());
      showOperation("已刷新");
    } catch (error) {
      renderStatus(runtime.getStatus());
      showOperation(errorText(error), true);
    }
  };

  const run = async (label, action) => {
    showOperation(`${label}…`);
    try {
      const result = await action();
      showOperation(result);
      await refresh();
    } catch (error) {
      showOperation(errorText(error), true);
    }
  };

  const setOpen = (open) => {
    overlay.hidden = !open;
    if (open) {
      closeButton.focus();
      void refresh();
    } else {
      openButton.focus();
    }
  };

  openButton.addEventListener("click", () => setOpen(true));
  closeButton.addEventListener("click", () => setOpen(false));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) setOpen(false);
  });
  for (const tab of mount.querySelectorAll("[data-bme-tab]")) {
    tab.addEventListener("click", () => {
      const name = tab.dataset.bmeTab;
      for (const candidate of mount.querySelectorAll("[data-bme-tab]")) {
        candidate.setAttribute("aria-selected", String(candidate === tab));
      }
      for (const page of mount.querySelectorAll("[data-bme-page]")) {
        page.hidden = page.dataset.bmePage !== name;
      }
      if (name === "graph" && latest) renderer.loadGraph(latest.graph);
    });
  }

  element(document, "st-bme-v9-refresh").addEventListener("click", refresh);
  element(document, "st-bme-v9-extract").addEventListener("click", () =>
    run("正在提取", () => runtime.manualExtract()));
  element(document, "st-bme-v9-vector").addEventListener("click", () =>
    run("正在重建向量", () => runtime.rebuildVectors()));
  element(document, "st-bme-v9-export").addEventListener("click", async () => {
    try {
      const text = await runtime.exportGraph();
      downloadText(document, `st-bme-v9-${latest?.chatKey || "graph"}.json`, text);
      showOperation("图谱已导出");
    } catch (error) {
      showOperation(errorText(error), true);
    }
  });
  element(document, "st-bme-v9-import").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) void run("正在导入", async () => runtime.importGraph(await file.text()));
    event.target.value = "";
  });
  element(document, "st-bme-v9-clear").addEventListener("click", () => {
    if (globalThis.confirm?.("清空当前聊天的 v9 图谱？此操作会形成可随楼层回退的事务。")) {
      void run("正在清空", () => runtime.clearGraph());
    }
  });

  nodeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selectedNode) return;
    void run("正在保存节点", () => runtime.updateNode(selectedNode.id, {
      importance: Number(element(document, "st-bme-v9-node-importance").value),
      archived: element(document, "st-bme-v9-node-archived").checked,
      fields: JSON.parse(element(document, "st-bme-v9-node-fields").value),
    }));
  });
  element(document, "st-bme-v9-node-delete").addEventListener("click", () => {
    if (!selectedNode || !globalThis.confirm?.(`删除节点 ${selectedNode.id}？`)) return;
    void run("正在删除节点", () => runtime.deleteNode(selectedNode.id));
  });

  element(document, "st-bme-v9-settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = element(document, "st-bme-v9-settings-note");
    try {
      const current = runtime.getSettings();
      const saved = await runtime.saveSettings({
        enabled: element(document, "st-bme-v9-enabled").checked,
        primary: element(document, "st-bme-v9-primary").value,
        authorityBaseUrl: element(document, "st-bme-v9-authority-url").value,
        ena: { ...current.ena, enabled: element(document, "st-bme-v9-ena").checked },
        extractAutoEnabled: element(document, "st-bme-v9-auto-extract").checked,
        recallEnabled: element(document, "st-bme-v9-recall").checked,
        extractEvery: Number(element(document, "st-bme-v9-extract-every").value),
        recallMaxNodes: Number(element(document, "st-bme-v9-recall-max").value),
        embeddingTransportMode: element(document, "st-bme-v9-embedding-mode").value,
        embeddingApiUrl: element(document, "st-bme-v9-embedding-url").value,
        embeddingApiKey: element(document, "st-bme-v9-embedding-key").value,
        embeddingModel: element(document, "st-bme-v9-embedding-model").value,
        taskProfiles: JSON.parse(element(document, "st-bme-v9-profiles").value),
        globalTaskRegex: JSON.parse(element(document, "st-bme-v9-regex").value),
      });
      note.textContent = saved.reloadRequired ? "已保存；Primary/启用状态/注入位置会在刷新页面后生效。" : "已保存并生效。";
      fillSettings(saved.settings);
    } catch (error) {
      note.textContent = errorText(error);
    }
  });

  const unsubscribe = runtime.subscribe(renderStatus);
  return () => {
    unsubscribe();
    renderer.destroy();
    mount.remove();
  };
}
