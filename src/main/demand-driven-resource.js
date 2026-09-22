class DemandDrivenResource {
  constructor(createResource) {
    this.createResource = createResource;
    this.resource = null;
    this.closePromise = null;
    this.active = false;
  }

  setActive(active) {
    this.active = Boolean(active);

    if (this.active) {
      this.ensureStarted();
    } else {
      this.stop();
    }
  }

  ensureStarted() {
    if (!this.active || this.resource || this.closePromise) {
      return;
    }

    this.resource = this.createResource();
  }

  stop() {
    if (!this.resource) {
      return this.closePromise;
    }

    const resource = this.resource;
    this.resource = null;
    let closeResult;

    try {
      closeResult = resource.close();
    } catch (error) {
      closeResult = Promise.reject(error);
    }

    const closePromise = Promise.resolve(closeResult)
      .catch(() => {})
      .finally(() => {
        if (this.closePromise === closePromise) {
          this.closePromise = null;
        }

        this.ensureStarted();
      });
    this.closePromise = closePromise;
    return closePromise;
  }
}

module.exports = {
  DemandDrivenResource
};
