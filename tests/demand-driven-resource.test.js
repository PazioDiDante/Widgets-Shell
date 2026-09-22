const assert = require('node:assert/strict');
const test = require('node:test');

const { DemandDrivenResource } = require('../src/main/demand-driven-resource');

test('demand-driven resource starts and stops only when activity changes', async () => {
  let starts = 0;
  let closes = 0;
  const controller = new DemandDrivenResource(() => {
    starts += 1;
    return {
      close() {
        closes += 1;
      }
    };
  });

  controller.setActive(true);
  controller.setActive(true);
  assert.equal(starts, 1);

  controller.setActive(false);
  await controller.closePromise;
  controller.setActive(false);
  assert.equal(closes, 1);
});

test('reactivation waits for the previous resource to finish closing', async () => {
  let resolveClose;
  let starts = 0;
  const controller = new DemandDrivenResource(() => {
    starts += 1;
    return {
      close: () => new Promise((resolve) => {
        resolveClose = resolve;
      })
    };
  });

  controller.setActive(true);
  controller.setActive(false);
  controller.setActive(true);
  assert.equal(starts, 1);

  resolveClose();
  await controller.closePromise;
  assert.equal(starts, 2);
});

test('a stopped resource is not restarted when closing completes', async () => {
  let resolveClose;
  let starts = 0;
  const controller = new DemandDrivenResource(() => {
    starts += 1;
    return {
      close: () => new Promise((resolve) => {
        resolveClose = resolve;
      })
    };
  });

  controller.setActive(true);
  controller.setActive(false);
  resolveClose();
  await controller.closePromise;

  assert.equal(starts, 1);
  assert.equal(controller.resource, null);
});
