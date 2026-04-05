const STYLE_ID = "st-bme-notice-style";
const HOST_ID = "st-bme-notice-host";

function resolveNoticeDocument() {
  const runtime = globalThis;
  const chatDocument = runtime?.SillyTavern?.Chat?.document;
  if (chatDocument && typeof chatDocument.createElement === "function") {
    return chatDocument;
  }

  try {
    return (window.parent && window.parent !== window ? window.parent : window).document;
  } catch {
    return document;
  }
}

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${HOST_ID} {
      position: fixed;
      top: 14px;
      right: 14px;
      z-index: 12020;
      width: min(400px, calc(100vw - 28px));
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }

    .st-bme-notice {
      --st-bme-accent: #73b8ff;
      pointer-events: auto;
      position: relative;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 12px;
      align-items: start;
      padding: 12px 12px 12px 10px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background:
        radial-gradient(circle at 10% -10%, rgba(115, 184, 255, 0.2), transparent 52%),
        linear-gradient(145deg, rgba(27, 37, 54, 0.95), rgba(12, 18, 29, 0.93));
      box-shadow:
        0 14px 34px rgba(4, 10, 17, 0.46),
        inset 0 0 0 1px rgba(255, 255, 255, 0.04);
      color: #edf3fb;
      overflow: hidden;
      transform: translateY(-8px) scale(0.985);
      opacity: 0;
      animation: stBmeNoticeIn 190ms ease forwards;
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif;
      backdrop-filter: blur(10px) saturate(125%);
      -webkit-backdrop-filter: blur(10px) saturate(125%);
    }

    .st-bme-notice[data-layout="compact"] {
      display: flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
      max-width: 100%;
      align-self: flex-end;
      padding: 10px;
    }

    .st-bme-notice::after {
      content: "";
      position: absolute;
      inset: 0;
      border-left: 3px solid var(--st-bme-accent);
      border-radius: 14px;
      pointer-events: none;
      opacity: 0.9;
    }

    .st-bme-notice--out {
      animation: stBmeNoticeOut 160ms ease forwards;
    }

    .st-bme-notice__icon {
      width: 30px;
      height: 30px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 800;
      color: #f4f8ff;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.16);
      flex-shrink: 0;
    }

    .st-bme-notice[data-busy="true"] .st-bme-notice__icon {
      animation: stBmeNoticeBusy 900ms linear infinite;
    }

    .st-bme-notice__content {
      min-width: 0;
    }

    .st-bme-notice[data-layout="compact"] .st-bme-notice__content {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    .st-bme-notice__title {
      margin: 0;
      font-size: 17px;
      line-height: 1.18;
      font-weight: 800;
      letter-spacing: 0.01em;
      color: #f0f6ff;
    }

    .st-bme-notice[data-layout="compact"] .st-bme-notice__title {
      font-size: 16px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .st-bme-notice__message {
      margin: 4px 0 0;
      font-size: 14px;
      line-height: 1.38;
      color: rgba(240, 246, 255, 0.86);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .st-bme-notice__message--marquee {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", monospace;
      font-size: 12.5px;
      color: rgba(240, 246, 255, 0.72);
      mask-image: linear-gradient(90deg, transparent 0%, black 6%, black 88%, transparent 100%);
      -webkit-mask-image: linear-gradient(90deg, transparent 0%, black 6%, black 88%, transparent 100%);
    }

    .st-bme-notice[data-layout="compact"] .st-bme-notice__message,
    .st-bme-notice[data-layout="compact"] .st-bme-notice__progress {
      display: none !important;
    }

    .st-bme-notice[data-layout="compact"] .st-bme-notice__actions {
      margin: 0 0 0 8px;
    }

    .st-bme-notice__actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }

    .st-bme-notice__action {
      min-height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.08);
      color: #eef4ff;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
    }

    .st-bme-notice__action:hover,
    .st-bme-notice__action:focus-visible {
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.24);
      transform: translateY(-1px);
      outline: none;
    }

    .st-bme-notice__action[data-kind="danger"] {
      background: rgba(245, 123, 143, 0.16);
      border-color: rgba(245, 123, 143, 0.42);
      color: #ffd9df;
    }

    .st-bme-notice__close {
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.08);
      color: #d7e0ec;
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      transition: background 140ms ease;
      flex-shrink: 0;
    }

    .st-bme-notice__close:hover,
    .st-bme-notice__close:focus-visible {
      background: rgba(255, 255, 255, 0.2);
      outline: none;
    }

    .st-bme-notice__progress {
      position: absolute;
      left: 0;
      bottom: 0;
      height: 2px;
      width: 100%;
      background: linear-gradient(90deg, var(--st-bme-accent), rgba(255, 255, 255, 0.24));
      transform-origin: left center;
      animation: stBmeNoticeProgress linear forwards;
    }

    .st-bme-notice[data-level="success"] {
      --st-bme-accent: #65d39c;
    }

    .st-bme-notice[data-level="error"] {
      --st-bme-accent: #f57b8f;
    }

    .st-bme-notice[data-level="warning"] {
      --st-bme-accent: #eab96f;
    }

    @keyframes stBmeNoticeIn {
      to {
        transform: translateY(0) scale(1);
        opacity: 1;
      }
    }

    @keyframes stBmeNoticeOut {
      to {
        transform: translateY(-6px) scale(0.98);
        opacity: 0;
      }
    }

    @keyframes stBmeNoticeProgress {
      from {
        transform: scaleX(1);
      }
      to {
        transform: scaleX(0);
      }
    }

    @keyframes stBmeNoticeBusy {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    @media (max-width: 900px) {
      #${HOST_ID} {
        top: 8px;
        right: 8px;
        width: calc(100vw - 16px);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .st-bme-notice,
      .st-bme-notice--out,
      .st-bme-notice__progress {
        animation-duration: 1ms !important;
      }
    }
  `;

  (doc.head || doc.documentElement).appendChild(style);
}

function ensureHost(doc) {
  let host = doc.getElementById(HOST_ID);
  if (host) return host;

  host = doc.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-atomic", "false");
  (doc.body || doc.documentElement).appendChild(host);
  return host;
}

function getIcon(level) {
  switch (level) {
    case "success":
      return "✓";
    case "error":
      return "!";
    case "warning":
      return "△";
    default:
      return "i";
  }
}

function applyNoticeState(item, input, progress) {
  const level = input.level || "info";
  const displayMode = input.displayMode === "compact" ? "compact" : "normal";
  const isCompact = displayMode === "compact";
  item.dataset.level = level;
  item.dataset.busy = input.busy ? "true" : "false";
  item.dataset.layout = displayMode;

  const icon = item.querySelector(".st-bme-notice__icon");
  if (icon) {
    icon.textContent = input.busy ? "◌" : getIcon(level);
  }

  const title = item.querySelector(".st-bme-notice__title");
  if (title) {
    title.textContent = input.title || "ST-BME";
  }

  const message = item.querySelector(".st-bme-notice__message");
  if (message) {
    message.textContent = input.message || "";
    message.hidden = isCompact || !String(input.message || "").trim();
    if (input.marquee) {
      message.classList.add("st-bme-notice__message--marquee");
    } else {
      message.classList.remove("st-bme-notice__message--marquee");
    }
  }

  const actionWrap = item.querySelector(".st-bme-notice__actions");
  const actionButton = item.querySelector(".st-bme-notice__action");
  if (actionWrap && actionButton) {
    if (input.action?.label) {
      actionWrap.style.display = "";
      actionButton.style.display = "";
      actionButton.textContent = input.action.label;
      actionButton.dataset.kind = input.action.kind || "neutral";
    } else {
      actionWrap.style.display = "none";
      actionButton.style.display = "none";
      actionButton.textContent = "";
      actionButton.dataset.kind = "neutral";
    }
  }

  if (input.persist || isCompact) {
    progress.style.display = "none";
    progress.style.animationDuration = "";
  } else {
    const duration = Math.max(1400, input.duration_ms || 3200);
    progress.style.display = "";
    progress.style.animationDuration = `${duration}ms`;
  }
}

export function showManagedBmeNotice(input) {
  const doc = resolveNoticeDocument();
  ensureStyle(doc);
  const host = ensureHost(doc);

  const item = doc.createElement("article");
  item.className = "st-bme-notice";

  const icon = doc.createElement("span");
  icon.className = "st-bme-notice__icon";

  const content = doc.createElement("div");
  content.className = "st-bme-notice__content";

  const title = doc.createElement("h4");
  title.className = "st-bme-notice__title";

  const message = doc.createElement("p");
  message.className = "st-bme-notice__message";

  const actions = doc.createElement("div");
  actions.className = "st-bme-notice__actions";

  const actionButton = doc.createElement("button");
  actionButton.className = "st-bme-notice__action";
  actionButton.type = "button";
  actionButton.style.display = "none";

  const closeButton = doc.createElement("button");
  closeButton.className = "st-bme-notice__close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "关闭提示");
  closeButton.textContent = "×";

  const progress = doc.createElement("div");
  progress.className = "st-bme-notice__progress";

  content.appendChild(title);
  content.appendChild(message);
  actions.appendChild(actionButton);
  content.appendChild(actions);
  item.appendChild(icon);
  item.appendChild(content);
  item.appendChild(closeButton);
  item.appendChild(progress);

  let currentInput = input || {};
  let closed = false;
  let closeTimer = null;

  const clearCloseTimer = () => {
    if (!closeTimer) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  };

  const close = () => {
    if (closed) return;
    clearCloseTimer();
    closed = true;
    item.classList.add("st-bme-notice--out");
    setTimeout(() => {
      item.remove();
      if (!host.childElementCount) {
        host.remove();
      }
    }, 170);
  };

  const scheduleAutoClose = (nextInput) => {
    clearCloseTimer();
    if (nextInput.persist) return;
    const duration = Math.max(1400, nextInput.duration_ms || 3200);
    closeTimer = setTimeout(close, duration);
  };

  const update = (nextInput) => {
    if (closed) return;
    currentInput = nextInput || {};
    applyNoticeState(item, currentInput, progress);
    scheduleAutoClose(currentInput);
  };

  applyNoticeState(item, currentInput, progress);
  scheduleAutoClose(currentInput);

  actionButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    currentInput.action?.onClick?.();
  });
  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  host.appendChild(item);

  return {
    update,
    dismiss: close,
    isClosed: () => closed,
  };
}

export function showBmeNotice(input) {
  return showManagedBmeNotice(input);
}
