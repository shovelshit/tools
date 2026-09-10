// 轻量 UI 组件: 顶部 toast + 模态对话框(替代原生 alert / confirm) + 各类 loading
// 依赖 style.css 中的 .toast-wrap / .dlg-overlay / .top-progress / .block-overlay / .panel-loading 样式
(function () {
  let activeDialog = null;

  function ensureToastWrap() {
    let wrap = document.querySelector(".toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "toast-wrap";
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  // showToast("内容", "success|error|warn|info")
  window.showToast = function (msg, type = "info", duration = 2600) {
    const wrap = ensureToastWrap();
    const t = document.createElement("div");
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    wrap.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, duration);
  };

  // 模态对话框(替代 alert), 返回 Promise, 点确定/Esc/遮罩后 resolve
  window.showDialog = function (msg, { title = "提示", type = "info", okText = "确定" } = {}) {
    return new Promise((resolve) => {
      closeActiveDialog();
      const icons = { info: "ℹ️", success: "✅", error: "⚠️" };
      const overlay = document.createElement("div");
      overlay.className = "dlg-overlay";
      overlay.innerHTML = `
        <div class="dlg-box" role="dialog" aria-modal="true">
          <div class="dlg-icon">${icons[type] || icons.info}</div>
          <div class="dlg-title"></div>
          <div class="dlg-msg"></div>
          <button class="btn primary block dlg-ok"></button>
        </div>`;
      overlay.querySelector(".dlg-title").textContent = title;
      overlay.querySelector(".dlg-msg").textContent = msg;
      overlay.querySelector(".dlg-ok").textContent = okText;
      const done = () => {
        document.removeEventListener("keydown", overlay._escHandler);
        overlay.remove();
        activeDialog = null;
        resolve();
      };
      overlay.querySelector(".dlg-ok").addEventListener("click", done);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done();
      });
      overlay._escHandler = (e) => {
        if (e.key === "Escape") done();
      };
      document.addEventListener("keydown", overlay._escHandler);
      document.body.appendChild(overlay);
      activeDialog = overlay;
    });
  };

  // 确认对话框(替代 confirm), 返回 Promise<boolean>
  window.showConfirm = function (
    msg,
    { title = "确认操作", okText = "确定", cancelText = "取消", danger = false } = {}
  ) {
    return new Promise((resolve) => {
      closeActiveDialog();
      const overlay = document.createElement("div");
      overlay.className = "dlg-overlay";
      overlay.innerHTML = `
        <div class="dlg-box" role="dialog" aria-modal="true">
          <div class="dlg-icon">${danger ? "⚠️" : "❓"}</div>
          <div class="dlg-title"></div>
          <div class="dlg-msg"></div>
          <div class="dlg-btns">
            <button class="btn ghost dlg-cancel"></button>
            <button class="btn ${danger ? "danger" : "primary"} dlg-ok"></button>
          </div>
        </div>`;
      overlay.querySelector(".dlg-title").textContent = title;
      overlay.querySelector(".dlg-msg").textContent = msg;
      overlay.querySelector(".dlg-cancel").textContent = cancelText;
      overlay.querySelector(".dlg-ok").textContent = okText;
      const close = (val) => {
        document.removeEventListener("keydown", overlay._escHandler);
        overlay.remove();
        activeDialog = null;
        resolve(val);
      };
      overlay.querySelector(".dlg-ok").addEventListener("click", () => close(true));
      overlay.querySelector(".dlg-cancel").addEventListener("click", () => close(false));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(false);
      });
      overlay._escHandler = (e) => {
        if (e.key === "Escape") close(false);
      };
      document.addEventListener("keydown", overlay._escHandler);
      document.body.appendChild(overlay);
      activeDialog = overlay;
    });
  };

  function closeActiveDialog() {
    if (activeDialog) {
      document.removeEventListener("keydown", activeDialog._escHandler);
      activeDialog.remove();
      activeDialog = null;
    }
  }

  // ---------------- Loading ----------------

  // 按钮 loading: 禁用按钮并插入转圈图标 + 文案, 结束后恢复
  // withButtonLoading(btn, "保存中...", () => api(...))
  window.withButtonLoading = async function (btn, loadingText, task) {
    if (!btn) return task();
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span><span></span>`;
    btn.lastChild.textContent = loadingText;
    try {
      return await task();
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  };

  // 顶部细进度条: 按请求计数显示/隐藏
  let pendingRequests = 0;
  let progressEl = null;
  function ensureProgress() {
    if (!progressEl) {
      progressEl = document.createElement("div");
      progressEl.className = "top-progress";
      document.body.appendChild(progressEl);
    }
    return progressEl;
  }
  window.startTopProgress = function () {
    pendingRequests++;
    ensureProgress().classList.add("active");
  };
  window.stopTopProgress = function () {
    pendingRequests = Math.max(0, pendingRequests - 1);
    if (!pendingRequests && progressEl) progressEl.classList.remove("active");
  };

  // 全屏阻塞遮罩: 用于登录连接等必须等待的操作
  let blockEl = null;
  window.showBlockOverlay = function (text = "加载中...") {
    hideBlockOverlay();
    blockEl = document.createElement("div");
    blockEl.className = "block-overlay";
    blockEl.innerHTML = `<div class="block-box"><span class="spinner big"></span><div class="block-text"></div></div>`;
    blockEl.querySelector(".block-text").textContent = text;
    document.body.appendChild(blockEl);
  };
  window.hideBlockOverlay = function () {
    if (blockEl) {
      blockEl.remove();
      blockEl = null;
    }
  };

  // 列表面板内联占位: 影片列表 / 变化记录加载中
  window.setPanelLoading = function (el, text = "加载中...") {
    if (!el) return;
    el.innerHTML = "";
    const box = document.createElement("div");
    box.className = "panel-loading";
    box.innerHTML = `<span class="spinner"></span><span></span>`;
    box.lastChild.textContent = text;
    el.appendChild(box);
  };
})();
