(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.maoyanWorkflow = api;
})(typeof window === "object" ? window : globalThis, function () {
  function deriveWorkflowState({
    connected = false,
    cinemaSelected = false,
    selectedMovieCount = 0,
    pushVerified = false,
    monitorEnabled = false,
    requestedStep,
  } = {}) {
    const hasConnection = connected === true;
    const hasCinema = hasConnection && cinemaSelected === true;
    const hasMovies = hasCinema && Number(selectedMovieCount) > 0;
    const hasNotification = hasMovies && pushVerified === true;
    const monitorRunning = hasConnection && monitorEnabled === true;
    const completion = [hasConnection, hasCinema, hasMovies, hasNotification || monitorRunning];
    const availability = [true, hasConnection, hasCinema, hasMovies || monitorRunning];
    const maxAvailableStep = availability.lastIndexOf(true) + 1;
    const hasRequestedStep = requestedStep !== null && requestedStep !== undefined && String(requestedStep).trim() !== "";
    const requested = hasRequestedStep && Number.isInteger(Number(requestedStep))
      ? Number(requestedStep)
      : maxAvailableStep;
    const clampedStep = Math.min(maxAvailableStep, Math.max(1, requested));
    const activeStep = availability[clampedStep - 1] ? clampedStep : maxAvailableStep;

    return {
      activeStep,
      maxAvailableStep,
      steps: completion.map((complete, index) => ({
        number: index + 1,
        complete,
        available: availability[index],
        active: activeStep === index + 1,
      })),
    };
  }

  function bindAmbientMotion({ window: windowTarget, document: documentTarget }) {
    const rootElement = documentTarget.documentElement;
    const update = () => {
      const unfocused = typeof documentTarget.hasFocus === "function" && !documentTarget.hasFocus();
      rootElement.classList.toggle("motion-paused", documentTarget.hidden === true || unfocused);
    };

    documentTarget.addEventListener("visibilitychange", update);
    windowTarget.addEventListener("focus", update);
    windowTarget.addEventListener("blur", update);
    update();

    return () => {
      documentTarget.removeEventListener("visibilitychange", update);
      windowTarget.removeEventListener("focus", update);
      windowTarget.removeEventListener("blur", update);
    };
  }

  function renderWorkflow(root, state) {
    for (const button of root.querySelectorAll("[data-workflow-step]")) {
      const step = state.steps[Number(button.dataset.workflowStep) - 1];
      if (!step) continue;
      button.disabled = !step.available;
      button.parentElement?.classList.toggle("is-complete", step.complete);
      button.parentElement?.classList.toggle("is-active", step.active);
      if (step.active) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
      const status = step.active ? "当前步骤" : step.complete ? "已完成" : step.available ? "可继续" : `等待步骤 ${step.number - 1}`;
      const statusElement = button.querySelector?.(".step-copy small");
      if (statusElement) statusElement.textContent = status;
    }

    for (const panel of root.querySelectorAll("[data-workflow-panel]")) {
      const active = Number(panel.dataset.workflowPanel) === state.activeStep;
      panel.classList.toggle("is-active", active);
      panel.setAttribute("aria-hidden", String(!active));
      panel.inert = !active;
    }

    const count = root.querySelector("#workflow-count");
    if (count) count.textContent = `${state.activeStep} / ${state.steps.length}`;
  }

  function createWorkflowTransition({ root, matchMedia, animate } = {}) {
    const stage = root.querySelector(".workflow-main");
    const panels = () => Array.from(root.querySelectorAll("[data-workflow-panel]"));
    const reducedMotion = () => {
      try { return matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; }
      catch { return false; }
    };
    let currentStep = null;
    let generation = 0;
    let currentAnimations = [];

    function clearTransientLayout() {
      for (const panel of panels()) panel.classList.remove("is-leaving");
      if (stage?.style) stage.style.minHeight = "";
    }

    function cancelAnimations() {
      for (const animation of currentAnimations) {
        try { animation?.cancel?.(); } catch {}
      }
      currentAnimations = [];
      clearTransientLayout();
    }

    function focusCurrent(panel) {
      const target = panel?.querySelector?.("h2, input:not([disabled]), button:not([disabled]), select:not([disabled])");
      if (!target || root.activeElement === target) return;
      if (target.matches?.("h2") && !target.hasAttribute?.("tabindex")) target.setAttribute?.("tabindex", "-1");
      target.focus?.({ preventScroll: true });
    }

    function render(state, { userInitiated = false } = {}) {
      const nextStep = Number(state?.activeStep);
      const previousStep = currentStep;
      const previousPanel = panels().find((panel) => Number(panel.dataset.workflowPanel) === previousStep);
      const previousHeight = Number(previousPanel?.offsetHeight || 0);
      generation += 1;
      const renderGeneration = generation;
      cancelAnimations();
      renderWorkflow(root, state);
      const currentPanel = panels().find((panel) => Number(panel.dataset.workflowPanel) === nextStep);
      currentStep = nextStep;

      if (previousStep === null || previousStep === nextStep || reducedMotion() || typeof animate !== "function") {
        clearTransientLayout();
        if (userInitiated && previousStep !== null && previousStep !== nextStep) focusCurrent(currentPanel);
        return;
      }

      const currentHeight = Number(currentPanel?.offsetHeight || 0);
      if (stage?.style && Math.max(previousHeight, currentHeight) > 0) {
        stage.style.minHeight = `${Math.max(previousHeight, currentHeight)}px`;
      }
      previousPanel?.classList.add("is-leaving");
      const forward = nextStep > previousStep;
      const incomingFrames = forward
        ? [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }]
        : [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "translateY(0)" }];
      const outgoingFrames = forward
        ? [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-6px)" }]
        : [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(6px)" }];
      const options = { duration: 180, easing: "ease-out", fill: "both" };
      currentAnimations = [
        previousPanel && animate(previousPanel, outgoingFrames, options),
        currentPanel && animate(currentPanel, incomingFrames, options)
      ].filter(Boolean);
      if (!currentAnimations.length) {
        clearTransientLayout();
        if (userInitiated) focusCurrent(currentPanel);
        return;
      }
      Promise.allSettled(currentAnimations.map((animation) => Promise.resolve(animation.finished).catch(() => {})))
        .then(() => {
          if (generation !== renderGeneration) return;
          currentAnimations = [];
          clearTransientLayout();
          if (userInitiated) focusCurrent(currentPanel);
        });
    }

    function dispose() {
      generation += 1;
      cancelAnimations();
      currentStep = null;
    }

    return { render, dispose };
  }

  return { bindAmbientMotion, createWorkflowTransition, deriveWorkflowState, renderWorkflow };
});
