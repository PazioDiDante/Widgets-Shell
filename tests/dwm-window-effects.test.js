const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  DwmWindowEffects,
  buildDwmBatchScript
} = require('../src/main/dwm-window-effects');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

function fakeWindow(handle) {
  return {
    handle,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    }
  };
}

test('DWM script keeps the existing visual attributes for every window', () => {
  const script = buildDwmBatchScript([
    { handle: '101', transparentDesktop: false, transitionsDisabled: true },
    { handle: '202', transparentDesktop: true, transitionsDisabled: false }
  ]);

  assert.equal((script.match(/Add-Type -TypeDefinition/g) || []).length, 1);
  assert.equal((script.match(/Set-WidgetsWindowAttributes -windowHandle/g) || []).length, 2);
  assert.match(script, /DwmSetWindowAttribute\(\$hwnd, 3,/);
  assert.match(script, /DwmSetWindowAttribute\(\$hwnd, 33,/);
  assert.match(script, /DwmSetWindowAttribute\(\$hwnd, 2,/);
  assert.match(script, /DwmSetWindowAttribute\(\$hwnd, 34,/);
  assert.match(script, /SetWindowCompositionAttribute/);
  assert.match(script, /-windowHandle '101' -transparentDesktop \$false -disableTransitions \$true/);
  assert.match(script, /-windowHandle '202' -transparentDesktop \$true -disableTransitions \$false/);
});

test('DWM requests are deduplicated per window and batched into one process', async () => {
  const launches = [];
  const effects = new DwmWindowEffects({
    platform: 'win32',
    getNativeWindowHandle: (window) => String(window.handle),
    spawnImpl: (executable, args, options) => {
      const child = new FakeChild();
      launches.push({ executable, args, options, child });
      return child;
    }
  });
  const firstWindow = fakeWindow(101);
  const secondWindow = fakeWindow(202);

  const firstRequest = effects.apply(firstWindow, {
    transparentDesktop: false,
    transitionsDisabled: false
  });
  const updatedFirstRequest = effects.apply(firstWindow, {
    transparentDesktop: true,
    transitionsDisabled: true
  });
  const secondRequest = effects.apply(secondWindow, {
    transparentDesktop: false,
    transitionsDisabled: false
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches.length, 1);
  assert.equal(launches[0].executable, 'powershell.exe');
  const script = launches[0].args.at(-1);
  assert.equal((script.match(/Set-WidgetsWindowAttributes -windowHandle/g) || []).length, 2);
  assert.match(script, /-windowHandle '101' -transparentDesktop \$true -disableTransitions \$true/);
  assert.match(script, /-windowHandle '202' -transparentDesktop \$false -disableTransitions \$false/);

  launches[0].child.emit('close', 0);
  await Promise.all([firstRequest, updatedFirstRequest, secondRequest]);
  effects.dispose();
});

test('DWM batches are serialized when more requests arrive during a running process', async () => {
  const launches = [];
  const effects = new DwmWindowEffects({
    platform: 'win32',
    getNativeWindowHandle: (window) => String(window.handle),
    spawnImpl: () => {
      const child = new FakeChild();
      launches.push(child);
      return child;
    }
  });

  const firstRequest = effects.apply(fakeWindow(1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches.length, 1);

  const secondRequest = effects.apply(fakeWindow(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches.length, 1);

  launches[0].emit('close', 0);
  await firstRequest;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches.length, 2);

  launches[1].emit('close', 0);
  await secondRequest;
  effects.dispose();
});

test('disposing DWM effects kills the active child and resolves queued work', async () => {
  let child;
  const effects = new DwmWindowEffects({
    platform: 'win32',
    getNativeWindowHandle: (window) => String(window.handle),
    spawnImpl: () => {
      child = new FakeChild();
      return child;
    }
  });

  const request = effects.apply(fakeWindow(7));
  await new Promise((resolve) => setImmediate(resolve));
  effects.dispose();
  await request;

  assert.equal(child.killed, true);
});
