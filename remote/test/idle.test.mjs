// Seam: the phone's idle sign-out controller — 15 quiet minutes sign out;
// any activity resets the countdown, which only restarts after the quiet
// period begins again.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createIdleController } from "../hub/web/app/idle.mjs";

const MIN = 60_000;

test("signs out after the idle period with no activity", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    let expired = 0;
    const c = createIdleController({ idleMs: 15 * MIN, onExpire: () => expired++ });
    c.start();
    mock.timers.tick(15 * MIN);
    assert.equal(expired, 1);
  } finally {
    mock.timers.reset();
  }
});

test("activity resets the countdown; it does not pause it", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    let expired = 0;
    const c = createIdleController({ idleMs: 15 * MIN, onExpire: () => expired++ });
    c.start();
    mock.timers.tick(14 * MIN);
    c.activity(); // using the app resets the counter
    mock.timers.tick(14 * MIN);
    assert.equal(expired, 0, "no expiry 14 min after the last activity");
    mock.timers.tick(1 * MIN);
    assert.equal(expired, 1, "expires 15 min after the last activity");
  } finally {
    mock.timers.reset();
  }
});

test("repeated activity keeps pushing expiry out", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    let expired = 0;
    const c = createIdleController({ idleMs: 15 * MIN, onExpire: () => expired++ });
    c.start();
    for (let i = 0; i < 20; i++) {
      mock.timers.tick(10 * MIN);
      c.activity();
    }
    assert.equal(expired, 0);
  } finally {
    mock.timers.reset();
  }
});

test("stop prevents any later expiry", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    let expired = 0;
    const c = createIdleController({ idleMs: 15 * MIN, onExpire: () => expired++ });
    c.start();
    c.stop();
    mock.timers.tick(60 * MIN);
    assert.equal(expired, 0);
  } finally {
    mock.timers.reset();
  }
});

// The check must be cheap: a single repeating sweep, no timer churn per
// gesture. Activities only move a timestamp.
test("activities never schedule or cancel timers; one repeating check only", () => {
  let scheduled = 0;
  let cancelled = 0;
  const c = createIdleController({
    idleMs: 15 * MIN,
    onExpire: () => {},
    schedule: () => {
      scheduled++;
      return scheduled;
    },
    cancel: () => cancelled++,
  });
  c.start();
  assert.equal(scheduled, 1);
  for (let i = 0; i < 50; i++) c.activity();
  assert.equal(scheduled, 1, "activity must not reschedule");
  assert.equal(cancelled, 0, "activity must not cancel");
  c.stop();
  assert.equal(cancelled, 1);
});
