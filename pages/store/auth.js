(function (root) {
  "use strict";

  function createController({ fetchImpl = root.fetch.bind(root), dispatch = (event) => root.dispatchEvent(event) } = {}) {
    let revision = 0;
    let active = false;
    let account = null;
    const pendingLogins = new Set();

    function emit(type, detail) {
      dispatch(new root.CustomEvent(type, { detail }));
    }

    function transition(nextAccount, requestRevision) {
      if (requestRevision !== revision) return false;
      account = nextAccount || null;
      active = account?.accountStatus === "active";
      emit(active ? "store:authenticated" : "store:unauthenticated", { account, revision });
      return true;
    }

    async function responseJson(response) {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = data.code || "";
        throw error;
      }
      return data;
    }

    async function restore() {
      const requestRevision = ++revision;
      try {
        const data = await responseJson(await fetchImpl("/store/auth/session", {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        }));
        transition(data.account, requestRevision);
        return data.account;
      } catch (error) {
        if (requestRevision === revision) transition(null, requestRevision);
        if (error.status !== 401) throw error;
        return null;
      }
    }

    async function login(key) {
      const requestRevision = ++revision;
      const operation = (async () => {
        const response = await fetchImpl("/store/auth/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ key: String(key || "").trim() })
        });
        const data = await responseJson(response);
        transition(data.account, requestRevision);
        return data.account;
      })();
      pendingLogins.add(operation);
      try {
        return await operation;
      } finally {
        pendingLogins.delete(operation);
      }
    }

    async function renew() {
      if (!account) throw new Error("当前没有可续期账号");
      const requestRevision = ++revision;
      const response = await fetchImpl("/store/auth/renew", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ requestId: root.crypto.randomUUID(), expectedVersion: account.version ?? account.accountVersion })
      });
      const data = await responseJson(response);
      transition(data.account, requestRevision);
      return data.account;
    }

    async function logout() {
      const requestRevision = ++revision;
      transition(null, requestRevision);
      await Promise.allSettled([...pendingLogins]);
      try {
        await fetchImpl("/store/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: "{}"
        });
      } catch {}
    }

    function invalidate() {
      const requestRevision = ++revision;
      transition(null, requestRevision);
    }

    async function handleAccessFailure(status) {
      if (status === 401) {
        invalidate();
        return;
      }
      if (status === 403) await restore();
    }

    return {
      restore, login, renew, logout, invalidate, handleAccessFailure,
      account: () => account,
      generation: () => revision,
      isAuthenticated: () => active,
      isCurrent: (candidate) => active && candidate === revision
    };
  }

  function init(document) {
    const controller = createController();
    const auth = document.getElementById("store-auth");
    const app = document.getElementById("store-app");
    const form = document.getElementById("store-login-form");
    const key = document.getElementById("store-key");
    const error = document.getElementById("store-auth-error");
    const status = document.getElementById("store-auth-status");
    const submit = document.getElementById("store-login-submit");
    const renew = document.getElementById("store-renew");
    const logout = document.getElementById("store-logout");
    const accountLabel = document.getElementById("store-account-label");

    function formatExpiry(account) {
      if (!account?.expiresAt) return "";
      return new Date(account.expiresAt).toLocaleString("zh-CN", { hour12: false });
    }

    function render(account) {
      const active = account?.accountStatus === "active";
      app.classList.toggle("auth-hidden", !active);
      auth.classList.toggle("auth-hidden", active);
      accountLabel.textContent = active ? `${account.remark || "Store 账号"} · ${formatExpiry(account)}` : "";
      renew.classList.toggle("auth-hidden", account?.accountStatus !== "expired");
      logout.classList.toggle("auth-hidden", !account);
      if (account?.accountStatus === "expired") {
        status.textContent = `账号已到期（${formatExpiry(account)}），续期后可继续访问。`;
      } else if (account && !active) {
        status.textContent = "账号当前不可用，请联系管理员。";
      } else {
        status.textContent = "使用应用商店访问密钥登录";
      }
    }

    root.addEventListener("store:authenticated", (event) => {
      error.textContent = "";
      key.value = "";
      render(event.detail.account);
    });
    root.addEventListener("store:unauthenticated", (event) => {
      if (event.detail.account) key.value = "";
      render(event.detail.account);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      submit.disabled = true;
      try {
        await controller.login(key.value);
      } catch (loginError) {
        error.textContent = loginError.message;
      } finally {
        submit.disabled = false;
      }
    });
    renew.addEventListener("click", async () => {
      renew.disabled = true;
      error.textContent = "";
      try {
        await controller.renew();
      } catch (renewError) {
        error.textContent = renewError.message;
      } finally {
        renew.disabled = false;
      }
    });
    logout.addEventListener("click", () => controller.logout());

    render(null);
    controller.restore().catch((restoreError) => { error.textContent = restoreError.message; });
    return controller;
  }

  root.StoreAuth = { createController, init };
})(typeof window !== "undefined" ? window : globalThis);
