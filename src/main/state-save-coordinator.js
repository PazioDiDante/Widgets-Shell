class StateSaveCoordinator {
  constructor(write, {
    delayMs = 250,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  } = {}) {
    this.write = write;
    this.delayMs = delayMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.timer = null;
  }

  schedule() {
    this.cancel();
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      this.write();
    }, this.delayMs);
  }

  writeNow() {
    this.cancel();
    this.write();
  }

  flush() {
    if (this.timer === null) {
      return;
    }

    this.cancel();
    this.write();
  }

  cancel() {
    if (this.timer === null) {
      return;
    }

    this.clearTimeoutImpl(this.timer);
    this.timer = null;
  }
}

module.exports = {
  StateSaveCoordinator
};
