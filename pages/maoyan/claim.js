(function (root) {
  function profileTokenKey(workerUrl) {
    return typeof root.webTokenKey === "function"
      ? root.webTokenKey(workerUrl)
      : `token:${encodeURIComponent(String(workerUrl || "").replace(/\/$/, ""))}`;
  }

  function createClaimController({
    api, secureGet, secureSet, workerUrl, collectFingerprint, onState,
    randomUUID = () => crypto.randomUUID(), navigate = () => {}
  }) {
    const pendingKey = `claim-pending:${encodeURIComponent(workerUrl)}`;
    const activeKey = profileTokenKey(workerUrl);
    let inFlight = null;
    let memoryPending = null;
    let disposed = false;

    function emit(name, details = {}) {
      if (!disposed) onState?.({ name, ...details });
    }

    async function read(key) {
      try { return await secureGet(key); } catch { return ""; }
    }

    async function existingAccount() {
      const key = await read(activeKey);
      if (!key) return null;
      try {
        const result = await api("/api/auth/session", { method: "POST", token: key });
        return result.account?.accountStatus === "active" ? { key, account: result.account } : null;
      } catch {
        return null;
      }
    }

    async function persistPending(value) {
      memoryPending = value;
      try {
        await secureSet(pendingKey, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }

    async function clearPending() {
      memoryPending = null;
      try { await secureSet(pendingKey, ""); } catch {}
    }

    async function activate(pending, result) {
      let stored = false;
      try {
        await secureSet(activeKey, pending.key);
        stored = await secureGet(activeKey) === pending.key;
        if (stored) await secureSet(pendingKey, "");
      } catch {
        stored = false;
      }
      memoryPending = stored ? null : pending;
      emit("active", {
        account: result.account,
        key: pending.key,
        ephemeral: !stored,
        expiresAt: result.account?.expiresAt || null
      });
      return result;
    }

    async function confirmPending(pending) {
      emit("pending-confirmation", { expiresAt: pending.reservationExpiresAt });
      const result = await api("/api/enrollment/confirm", {
        method: "POST",
        token: pending.key,
        body: { requestId: pending.requestId }
      });
      return await activate(pending, result);
    }

    async function recoverLostReserve(requestId) {
      try {
        const status = await api(`/api/enrollment/status?request_id=${encodeURIComponent(requestId)}`);
        if (status.status === "reserved") {
          emit("pending-confirmation", {
            requestId,
            expiresAt: status.expiresAt,
            keyUnavailable: true,
            message: "申请已预留，但一次性密钥响应未收到；预留过期后可重新申请"
          });
          return status;
        }
        if (status.status === "confirmed") {
          emit("error", { message: "账号已生效，但本机没有保存访问密钥，密钥无法找回" });
          return status;
        }
        if (status.status === "missing" || status.status === "expired") await clearPending();
      } catch {}
      throw new Error("申请状态暂时无法确认，请稍后重试");
    }

    async function startOperation(turnstileToken) {
      const existing = await existingAccount();
      if (existing) {
        emit("active", { account: existing.account, existing: true, ephemeral: false });
        return existing;
      }
      emit("verifying");
      const identity = await collectFingerprint();
      const requestId = randomUUID();
      await persistPending({ requestId, reservationExpiresAt: null });
      emit("reserving");
      let reservation;
      try {
        reservation = await api("/api/enrollment/reserve", {
          method: "POST",
          body: { requestId, ...identity, turnstileToken }
        });
      } catch (error) {
        if (error?.code === "CAPACITY_FULL" || error?.code === "RESOURCE_EXHAUSTED") {
          await clearPending();
          emit("full", { message: error.message });
          return null;
        }
        if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
          await clearPending();
          throw error;
        }
        return await recoverLostReserve(requestId);
      }
      if (!reservation.key) {
        emit("pending-confirmation", {
          requestId,
          expiresAt: reservation.expiresAt,
          keyUnavailable: true,
          message: "申请已预留，但一次性密钥不可再次显示"
        });
        return reservation;
      }
      const pending = {
        requestId,
        key: reservation.key,
        reservationExpiresAt: reservation.expiresAt
      };
      await persistPending(pending);
      return await confirmPending(pending);
    }

    function start(turnstileToken) {
      if (!inFlight) {
        inFlight = startOperation(turnstileToken)
          .catch((error) => { emit("error", { message: error.message || "申请失败" }); throw error; })
          .finally(() => { inFlight = null; });
      }
      return inFlight;
    }

    async function restorePending() {
      let pending = memoryPending;
      if (!pending) {
        const raw = await read(pendingKey);
        try { pending = raw ? JSON.parse(raw) : null; } catch { pending = null; }
      }
      if (!pending?.requestId) return null;
      memoryPending = pending;
      if (pending.key) return await confirmPending(pending);
      return await recoverLostReserve(pending.requestId);
    }

    async function confirm() {
      if (!memoryPending?.key) return await restorePending();
      return await confirmPending(memoryPending);
    }

    async function enterWeb(targetUrl) {
      const active = await read(activeKey);
      if (!active && memoryPending?.key) await activate(memoryPending, { account: null });
      navigate(targetUrl);
    }

    return {
      start,
      confirm,
      restorePending,
      enterWeb,
      dispose() { disposed = true; }
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createClaimController };
  if (root) root.createClaimController = createClaimController;
})(typeof window !== "undefined" ? window : globalThis);
