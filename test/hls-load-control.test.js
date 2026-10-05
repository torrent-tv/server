import test from "node:test";
import assert from "node:assert/strict";
import { constrainOutputLevel, fixedOutputErrorController } from "../public/domain/hls-load-control.js";
import Hls from "hls.js";

class LevelController {
  selected = -1;
  loaded = -1;
  get level() { return this.loaded; }
  set level(value) { this.loaded = value; }
  get manualLevel() { return this.selected; }
  set manualLevel(value) { this.selected = value; this.level = value; }
  get nextLoadLevel() { return this.selected; }
  set nextLoadLevel(value) { this.level = value; }
  removals = [];
  removeLevel(value) { this.removals.push(value); }
}

test("automatic changes cannot load another output or restore automatic selection", () => {
  let selected = 2;
  const controller = new LevelController();
  const instance = { levelController: controller };
  constrainOutputLevel(instance, () => selected);
  controller.manualLevel = 2;
  for (const name of ["level", "manualLevel", "nextLoadLevel"]) controller[name] = 0;
  controller.manualLevel = -1;
  assert.equal(controller.level, 2);
  assert.equal(controller.manualLevel, 2);
  selected = 1;
  controller.manualLevel = 1;
  assert.equal(controller.level, 1);
  assert.equal(controller.manualLevel, 1);
  controller.removeLevel(0);
  assert.deepEqual(controller.removals, [], "removing another level would renumber the pinned output");
  selected = -1;
  controller.removeLevel(0);
  assert.deepEqual(controller.removals, [0]);
});

test("an error requiring an alternative terminates without changing the output", () => {
  let stopped = 0;
  let delegated = 0;
  class ErrorController {
    hls = { stopLoad() { stopped++; } };
    onErrorOut() { delegated++; }
  }
  const Controller = fixedOutputErrorController(ErrorController);
  const controller = new Controller();
  const failure = { errorAction: { action: 2, nextAutoLevel: 0 } };
  controller.onErrorOut("error", failure);
  assert.equal(stopped, 1);
  assert.equal(delegated, 0);
  assert.equal(failure.fatal, true);
  assert.equal(failure.outputTerminal, true);
  assert.deepEqual(failure.errorAction, { action: 0, flags: 0, resolved: false });
  controller.onErrorOut("error", { errorAction: { action: 5 } });
  assert.equal(delegated, 1);
});

test("the installed HLS controllers retain their level list under guarded removal", () => {
  // No media is attached and no URL is loaded: this checks controller contracts.
  const hls = new Hls({ autoStartLoad: false, enableWorker: false,
    errorController: fixedOutputErrorController(Hls.DefaultConfig.errorController) });
  try {
    const levels = hls.levels;
    let updated = 0;
    hls.on(Hls.Events.LEVELS_UPDATED, () => { updated++; });
    constrainOutputLevel(hls, () => 0);
    hls.removeLevel(0);
    assert.deepEqual(hls.levels, levels);
    assert.equal(updated, 0);
    hls.levelController.manualLevel = 0;
    hls.levelController.manualLevel = -1;
    assert.equal(hls.levelController.manualLevel, 0);
  } finally {
    hls.destroy();
  }
});

test("terminal source refusals stop retries while connection loss waits for reconnection", () => {
  class ErrorController {
    hls = { stopLoad() {} };
    onErrorOut() { assert.fail("The automatic recovery must not run."); }
  }
  const Controller = fixedOutputErrorController(ErrorController);
  const terminal = { networkDetails: { canRetry: false }, errorAction: { action: 1 } };
  new Controller().onErrorOut("error", terminal);
  assert.equal(terminal.fatal, true);
  assert.equal(terminal.outputTerminal, true);
  const disconnected = { networkDetails: { canRetry: true, waitingTransport: true }, errorAction: { action: 2 } };
  new Controller().onErrorOut("error", disconnected);
  assert.equal(disconnected.fatal, false);
  assert.equal(disconnected.outputTerminal, undefined);
  const olderProxy = { networkDetails: { canRetry: true }, errorAction: { action: 2 } };
  new Controller().onErrorOut("error", olderProxy);
  assert.equal(olderProxy.outputTerminal, false);
});
