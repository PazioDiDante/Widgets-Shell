const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureVisibleBounds, isWindowVisible } = require('../src/main/window-bounds');

const primary = { x: 0, y: 0, width: 1920, height: 1040 };

test('keeps a window that is sufficiently visible on any display', () => {
  const bounds = { x: 2100, y: 120, width: 320, height: 220 };
  const second = { x: 1920, y: 0, width: 2560, height: 1400 };

  assert.deepEqual(ensureVisibleBounds(bounds, [primary, second], second, primary), bounds);
  assert.equal(isWindowVisible(bounds, [primary, second]), true);
});

test('maps an offscreen window proportionally from its saved display to the remaining display', () => {
  const previousDisplay = { x: 1920, y: 0, width: 2560, height: 1400 };
  const bounds = { x: 3200, y: 700, width: 400, height: 200 };

  assert.deepEqual(ensureVisibleBounds(bounds, [primary], previousDisplay, primary), {
    x: 901,
    y: 490,
    width: 400,
    height: 200
  });
});

test('recovers legacy offscreen coordinates when no saved display metadata exists', () => {
  const bounds = { x: 2200, y: 200, width: 320, height: 220 };

  assert.deepEqual(ensureVisibleBounds(bounds, [primary], null, primary), {
    x: 233,
    y: 158,
    width: 320,
    height: 220
  });
});

test('recovers a window when only a thin inaccessible sliver intersects a display', () => {
  const bounds = { x: 1900, y: 100, width: 320, height: 220 };
  const recovered = ensureVisibleBounds(bounds, [primary], null, primary);

  assert.equal(isWindowVisible(bounds, [primary]), false);
  assert.equal(isWindowVisible(recovered, [primary]), true);
});

test('places a window larger than the work area at the work-area origin', () => {
  const bounds = { x: 2500, y: 1200, width: 2400, height: 1200 };

  assert.deepEqual(ensureVisibleBounds(bounds, [primary], null, primary), {
    x: 0,
    y: 0,
    width: 2400,
    height: 1200
  });
});
