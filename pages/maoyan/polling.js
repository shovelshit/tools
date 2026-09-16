(function (root) {
  function nextPollDelay({ visible, step, monitorEnabled, lockOpen, lockActive }) {
    if (!visible) return null;
    if (lockOpen && lockActive) return 15_000;
    return step === 4 && monitorEnabled ? 180_000 : null;
  }

  function createPollingController({
    document, requestStatus, requestChanges, requestLock, onStatus, onChanges,
    setTimer = setTimeout, clearTimer = clearTimeout
  }) {
    let state = {
      connected: false,
      step: 1,
      monitorEnabled: false,
      lockOpen: false,
      lockActive: false,
      profileKey: "",
      visible: document.visibilityState !== "hidden"
    };
    let timer = null;
    let inFlight = null;
    let generation = 0;
    let changesVersion = null;
    let afterId = null;
    let failed = false;
    let disposed = false;

    function cancelTimer() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function delay() {
      if (!state.connected) return null;
      const regular = nextPollDelay(state);
      if (regular == null) return null;
      return failed ? Math.max(60_000, regular) : regular;
    }

    function schedule() {
      cancelTimer();
      const wait = delay();
      if (disposed || wait == null) return;
      timer = setTimer(() => {
        timer = null;
        void refresh();
      }, wait);
    }

    async function refresh({ forceChanges = false } = {}) {
      if (disposed || !state.connected || !state.visible) return null;
      if (inFlight) return inFlight;
      if (forceChanges) {
        changesVersion = null;
        afterId = null;
      }
      const currentGeneration = generation;
      inFlight = (async () => {
        try {
          const summary = await requestStatus();
          if (disposed || currentGeneration !== generation) return null;
          onStatus?.(summary);
          if (forceChanges || changesVersion === null || Number(summary.changesVersion) !== Number(changesVersion)) {
            const reset = afterId == null;
            const page = await requestChanges(afterId);
            if (disposed || currentGeneration !== generation) return null;
            if (page.items?.length) afterId = page.nextAfterId;
            changesVersion = Number(summary.changesVersion || 0);
            onChanges?.(page, { reset });
          }
          if (state.lockOpen && state.lockActive && requestLock) await requestLock();
          failed = false;
          return summary;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          inFlight = null;
          schedule();
        }
      })();
      return inFlight;
    }

    function update(next = {}) {
      const previousProfile = state.profileKey;
      state = { ...state, ...next, visible: document.visibilityState !== "hidden" };
      if (state.profileKey !== previousProfile) {
        generation += 1;
        changesVersion = null;
        afterId = null;
        failed = false;
      }
      schedule();
    }

    function onVisibility() {
      const wasVisible = state.visible;
      state.visible = document.visibilityState !== "hidden";
      if (!state.visible) cancelTimer();
      else if (!wasVisible) void refresh().catch(() => {});
      else schedule();
    }

    document.addEventListener("visibilitychange", onVisibility);
    return {
      update,
      refresh,
      dispose() {
        disposed = true;
        generation += 1;
        cancelTimer();
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }

  const exported = { nextPollDelay, createPollingController };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root) {
    root.nextMaoyanPollDelay = nextPollDelay;
    root.createMaoyanPollingController = createPollingController;
  }
})(typeof window !== "undefined" ? window : globalThis);
