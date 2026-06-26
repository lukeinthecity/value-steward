import test from "node:test";
import assert from "node:assert/strict";

import { isPidAlive } from "../core/stewardState.js";

// isPidAlive is the platform-specific primitive behind the state-lock
// PID-ownership eviction. The eviction algorithm itself is identical to the
// Python implementation and is adversarially tested in tests/test_state_lock.py.

test("isPidAlive: current process is alive", () => {
  assert.equal(isPidAlive(process.pid), true);
});

test("isPidAlive: pid<=0 is never alive (would target a process group)", () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(-process.pid), false);
});

test("isPidAlive: non-integer / non-existent pid is not alive", () => {
  assert.equal(isPidAlive(NaN), false);
  assert.equal(isPidAlive(1.5), false);
  // A pid far above the OS max won't exist -> process.kill throws ESRCH.
  assert.equal(isPidAlive(2_000_000_000), false);
});
