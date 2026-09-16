const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkflowTransition, deriveWorkflowState } = require("./workflow.js");

class ClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) { if (force) this.values.add(name); else this.values.delete(name); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

function element(dataset = {}) {
  const attributes = new Map();
  return {
    dataset, classList: new ClassList(), inert: false, disabled: false, textContent: "",
    offsetHeight: 120, parentElement: null,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    querySelector() { return null; },
    focus() { this.focused = true; }
  };
}

function fixture() {
  const panels = [1, 2, 3, 4].map((number) => element({ workflowPanel: String(number) }));
  const buttons = [1, 2, 3, 4].map((number) => {
    const button = element({ workflowStep: String(number) });
    button.parentElement = element();
    return button;
  });
  const stage = element();
  stage.style = {};
  const count = element();
  const root = {
    activeElement: null,
    querySelectorAll(selector) {
      if (selector === "[data-workflow-panel]") return panels;
      if (selector === "[data-workflow-step]") return buttons;
      return [];
    },
    querySelector(selector) {
      if (selector === ".workflow-main") return stage;
      if (selector === "#workflow-count") return count;
      return null;
    }
  };
  return { root, panels, stage };
}

function state(step) {
  return deriveWorkflowState({
    connected: true, cinemaSelected: true, selectedMovieCount: 1, requestedStep: step
  });
}

test("same step updates do not replay transition", () => {
  const { root } = fixture();
  let animations = 0;
  const controller = createWorkflowTransition({
    root,
    matchMedia: () => ({ matches: false }),
    animate: () => { animations += 1; return { finished: Promise.resolve(), cancel() {} }; }
  });
  controller.render(state(2));
  controller.render(state(3));
  const count = animations;
  controller.render(state(3));
  assert.equal(animations, count);
  controller.dispose();
});

test("rapid switching cancels stale animations and preserves newest panel", async () => {
  const { root, panels } = fixture();
  const animations = [];
  const controller = createWorkflowTransition({
    root,
    matchMedia: () => ({ matches: false }),
    animate: (target) => {
      let resolve;
      const finished = new Promise((done) => { resolve = done; });
      const item = { target, finished, resolve, cancelled: false, cancel() { this.cancelled = true; resolve(); } };
      animations.push(item);
      return item;
    }
  });
  controller.render(state(2));
  controller.render(state(3));
  controller.render(state(4));
  assert.equal(animations.slice(0, 2).every((item) => item.cancelled), true);
  animations.slice(2).forEach((item) => item.resolve());
  await Promise.resolve();
  assert.equal(panels[3].classList.contains("is-active"), true);
  assert.equal(panels[3].inert, false);
  assert.deepEqual(panels.slice(0, 3).map((panel) => panel.inert), [true, true, true]);
  controller.dispose();
});

test("reduced motion renders immediately without animations", () => {
  const { root, panels, stage } = fixture();
  let animations = 0;
  const controller = createWorkflowTransition({
    root,
    matchMedia: () => ({ matches: true }),
    animate: () => { animations += 1; }
  });
  controller.render(state(2));
  controller.render(state(4));
  assert.equal(animations, 0);
  assert.equal(panels[3].getAttribute("aria-hidden"), "false");
  assert.equal(stage.style.minHeight || "", "");
  controller.dispose();
});
