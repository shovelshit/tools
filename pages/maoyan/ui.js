// 轻量提示组件: 顶部 toast + 模态对话框(替代原生 alert / confirm)
// 依赖 style.css 中的 .toast-wrap / .dlg-overlay 样式
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
})();
