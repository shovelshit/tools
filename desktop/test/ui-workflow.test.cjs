const assert = require("node:assert/strict");
const test = require("node:test");

const { bindAmbientMotion, deriveWorkflowState, renderWorkflow } = require("../../pages/maoyan/workflow.js");

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener(); }
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}

function fakeElement(dataset = {}) {
  const attributes = new Map();
  const small = { textContent: "" };
  return {
    dataset,
    classList: new FakeClassList(),
    disabled: false,
    textContent: "",
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    querySelector(selector) { return selector === ".step-copy small" ? small : null; },
    small,
  };
}

test("workflow keeps disconnected users on connection step", () => {
  const state = deriveWorkflowState({
    connected: false,
    cinemaSelected: false,
    selectedMovieCount: 0,
    pushVerified: false,
    requestedStep: 4,
  });

  assert.equal(state.activeStep, 1);
  assert.equal(state.maxAvailableStep, 1);
  assert.deepEqual(state.steps.map(({ complete, available, active }) => ({ complete, available, active })), [
    { complete: false, available: true, active: true },
    { complete: false, available: false, active: false },
    { complete: false, available: false, active: false },
    { complete: false, available: false, active: false },
  ]);
});

test("workflow unlocks each configuration step only after its prerequisite", () => {
  const connected = deriveWorkflowState({ connected: true, requestedStep: 4 });
  assert.equal(connected.activeStep, 2);
  assert.equal(connected.maxAvailableStep, 2);

  const cinema = deriveWorkflowState({ connected: true, cinemaSelected: true, requestedStep: 4 });
  assert.equal(cinema.activeStep, 3);
  assert.equal(cinema.maxAvailableStep, 3);

  const movies = deriveWorkflowState({
    connected: true,
    cinemaSelected: true,
    selectedMovieCount: 2,
    requestedStep: 4,
  });
  assert.equal(movies.activeStep, 4);
  assert.equal(movies.maxAvailableStep, 4);
  assert.deepEqual(movies.steps.map(({ complete }) => complete), [true, true, true, false]);

  const ready = deriveWorkflowState({
    connected: true,
    cinemaSelected: true,
    selectedMovieCount: 2,
    pushVerified: true,
    requestedStep: 4,
  });
  assert.deepEqual(ready.steps.map(({ complete }) => complete), [true, true, true, true]);
});

test("workflow allows returning to available steps and clamps invalid requests", () => {
  const input = {
    connected: true,
    cinemaSelected: true,
    selectedMovieCount: 1,
    pushVerified: false,
  };

  assert.equal(deriveWorkflowState({ ...input, requestedStep: 2 }).activeStep, 2);
  assert.equal(deriveWorkflowState({ ...input, requestedStep: 99 }).activeStep, 4);
  assert.equal(deriveWorkflowState({ ...input, requestedStep: -5 }).activeStep, 1);
  assert.equal(deriveWorkflowState({ ...input, requestedStep: "bad" }).activeStep, 4);
  assert.equal(deriveWorkflowState({ ...input, requestedStep: null }).activeStep, 4);
  assert.equal(deriveWorkflowState({ ...input, requestedStep: "" }).activeStep, 4);
});

test("ambient motion pauses while hidden or unfocused and cleanup removes listeners", () => {
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget();
  const classList = new FakeClassList();
  let focused = true;
  documentTarget.hidden = false;
  documentTarget.hasFocus = () => focused;
  documentTarget.documentElement = { classList };

  const cleanup = bindAmbientMotion({ window: windowTarget, document: documentTarget });
  assert.equal(classList.contains("motion-paused"), false);

  focused = false;
  windowTarget.dispatch("blur");
  assert.equal(classList.contains("motion-paused"), true);

  focused = true;
  windowTarget.dispatch("focus");
  assert.equal(classList.contains("motion-paused"), false);

  documentTarget.hidden = true;
  documentTarget.dispatch("visibilitychange");
  assert.equal(classList.contains("motion-paused"), true);

  cleanup();
  documentTarget.hidden = false;
  focused = true;
  documentTarget.dispatch("visibilitychange");
  windowTarget.dispatch("focus");
  assert.equal(classList.contains("motion-paused"), true);
});

test("workflow renderer exposes only the active panel and synchronizes accessible step state", () => {
  const buttons = [1, 2, 3, 4].map((number) => {
    const button = fakeElement({ workflowStep: String(number) });
    button.parentElement = fakeElement();
    return button;
  });
  const panels = [2, 3, 4].map((number) => fakeElement({ workflowPanel: String(number) }));
  const count = fakeElement();
  const root = {
    querySelectorAll(selector) {
      if (selector === "[data-workflow-step]") return buttons;
      if (selector === "[data-workflow-panel]") return panels;
      return [];
    },
    querySelector(selector) { return selector === "#workflow-count" ? count : null; },
  };
  const state = deriveWorkflowState({
    connected: true,
    cinemaSelected: true,
    selectedMovieCount: 2,
    pushVerified: false,
    requestedStep: 3,
  });

  renderWorkflow(root, state);

  assert.equal(count.textContent, "3 / 4");
  assert.deepEqual(buttons.map((button) => button.disabled), [false, false, false, false]);
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-current")), [null, null, "step", null]);
  assert.deepEqual(buttons.map((button) => button.parentElement.classList.contains("is-complete")), [true, true, true, false]);
  assert.deepEqual(buttons.map((button) => button.small.textContent), ["已完成", "已完成", "当前步骤", "可继续"]);
  assert.deepEqual(panels.map((panel) => panel.classList.contains("is-active")), [false, true, false]);
  assert.deepEqual(panels.map((panel) => panel.getAttribute("aria-hidden")), ["true", "false", "true"]);
});
