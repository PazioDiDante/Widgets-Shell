const assert = require('node:assert/strict');
const test = require('node:test');

const { StateSaveCoordinator } = require('../src/main/state-save-coordinator');

function createFakeTimers() {
  let nextId = 0;
  const callbacks = new Map();

  return {
    setTimeoutImpl(callback) {
      nextId += 1;
      callbacks.set(nextId, callback);
      return nextId;
    },
    clearTimeoutImpl(id) {
      callbacks.delete(id);
    },
    runPending() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback());
    },
    get size() {
      return callbacks.size;
    }
  };
}

test('scheduled state writes collapse repeated move and resize events', () => {
  const timers = createFakeTimers();
  let writes = 0;
  const coordinator = new StateSaveCoordinator(() => {
    writes += 1;
  }, timers);

  coordinator.schedule();
  coordinator.schedule();
  coordinator.schedule();

  assert.equal(timers.size, 1);
  assert.equal(writes, 0);
  timers.runPending();
  assert.equal(writes, 1);
});

test('immediate writes cancel a pending deferred write', () => {
  const timers = createFakeTimers();
  let writes = 0;
  const coordinator = new StateSaveCoordinator(() => {
    writes += 1;
  }, timers);

  coordinator.schedule();
  coordinator.writeNow();
  timers.runPending();

  assert.equal(writes, 1);
  assert.equal(timers.size, 0);
});

test('flush writes only when deferred state is pending', () => {
  const timers = createFakeTimers();
  let writes = 0;
  const coordinator = new StateSaveCoordinator(() => {
    writes += 1;
  }, timers);

  coordinator.flush();
  coordinator.schedule();
  coordinator.flush();
  coordinator.flush();

  assert.equal(writes, 1);
  assert.equal(timers.size, 0);
});
