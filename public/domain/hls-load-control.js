/** Keep automatic HLS error handling from changing the selected output. */
export function fixedOutputErrorController(BaseController) {
  return class FixedOutputErrorController extends BaseController {
    onErrorOut(event, data) {
      if (data.networkDetails?.waitingTransport) {
        data.errorAction = { action: 0, flags: 0, resolved: true };
        data.fatal = false;
        this.hls.stopLoad();
        return;
      }
      if (data.networkDetails?.canRetry === false) {
        data.errorAction = { action: 0, flags: 0, resolved: false };
        data.fatal = true;
        data.outputTerminal = true;
        this.hls.stopLoad();
        return;
      }
      if (data.errorAction?.action === 2) {
        data.errorAction = { action: 0, flags: 0, resolved: false };
        data.fatal = true;
        data.outputTerminal = data.networkDetails?.canRetry !== true;
        this.hls.stopLoad();
        return;
      }
      super.onErrorOut(event, data);
    }
  };
}

/** Check changes before the level controller starts fetching another output. */
export function constrainOutputLevel(instance, selectedLevel) {
  const controller = instance.levelController;
  if (!controller) throw new Error("HLS level controller is unavailable.");
  for (const name of ["level", "manualLevel", "nextLoadLevel"]) {
    let prototype = Object.getPrototypeOf(controller);
    let descriptor;
    while (prototype && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!descriptor?.get || !descriptor?.set) {
      throw new Error(`HLS level controller does not expose ${name}.`);
    }
    Object.defineProperty(controller, name, {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        const selected = selectedLevel();
        if (selected >= 0 && value !== selected) {
          console.debug(`[torrent-tv][hls] ignored automatic ${name}=${value}; selected=${selected}`);
          return;
        }
        descriptor.set.call(this, value);
      }
    });
  }
  if (typeof controller.removeLevel !== "function") throw new Error("HLS level controller cannot guard level removal.");
  const removeLevel = controller.removeLevel;
  controller.removeLevel = function (...args) {
    if (selectedLevel() >= 0) {
      console.debug("[torrent-tv][hls] ignored automatic level removal while an output is selected");
      return;
    }
    return removeLevel.apply(this, args);
  };
}
