const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { WindowsMediaSessionMonitor } = require('../src/main/windows-media-session');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      destroyed: false,
      writable: true,
      writes: [],
      write: (value, callback) => {
        this.stdin.writes.push(value);
        callback?.();
      },
      end: () => {
        this.stdin.writable = false;
      }
    };
    this.killed = false;
  }

  kill() {
    this.killed = true;
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

test('monitor waits for the previous helper to close before restarting', async () => {
  const launches = [];
  const monitor = new WindowsMediaSessionMonitor({
    platform: 'win32',
    parentPid: 4242,
    helperPath: 'helper.exe',
    spawnImpl: (executable, args, options) => {
      const child = new FakeChild();
      launches.push({ executable, args, options, child });
      return child;
    }
  });

  assert.equal(monitor.start(() => {}), true);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args, ['--parent-pid', '4242']);

  monitor.stop();
  monitor.start(() => {});
  assert.equal(launches.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(launches.length, 2);

  monitor.stop();
});

test('monitor parses complete JSON lines without retaining them', () => {
  const events = [];
  const monitor = new WindowsMediaSessionMonitor({ platform: 'linux' });
  monitor.onEvent = (event) => events.push(event);

  monitor.consumeStdout(Buffer.from('{"type":"ready"}\n{"type":"play'));
  monitor.consumeStdout(Buffer.from('back","isPlaying":true}\n'));

  assert.deepEqual(events, [
    { type: 'ready' },
    { type: 'playback', isPlaying: true }
  ]);
  assert.equal(monitor.stdoutBuffer, '');
});

test('monitor drops an unterminated helper line that exceeds the memory safety limit', () => {
  const events = [];
  const monitor = new WindowsMediaSessionMonitor({ platform: 'linux' });
  monitor.onEvent = (event) => events.push(event);

  monitor.consumeStdout(Buffer.alloc(1024 * 1024 + 1, 'x'));

  assert.equal(monitor.stdoutBuffer, '');
  assert.deepEqual(events, [{
    type: 'unavailable',
    message: 'Windows media helper output exceeded its safety limit.'
  }]);
});

test('monitor defaults to the v3 helper with a writable stdin channel', () => {
  const monitor = new WindowsMediaSessionMonitor({ platform: 'linux' });
  assert.match(monitor.helperPath, /windows-media-session-v3\.exe$/);
});

test('monitor sends supported media keys through the existing helper stdin', async () => {
  let child;
  const monitor = new WindowsMediaSessionMonitor({
    platform: 'win32',
    spawnImpl: () => {
      child = new FakeChild();
      return child;
    }
  });

  assert.equal(monitor.sendMediaKey('next'), null);
  monitor.start(() => {});
  await monitor.sendMediaKey('previous');
  await monitor.sendMediaKey('play-pause');
  await monitor.sendMediaKey('next');

  assert.deepEqual(child.stdin.writes, [
    'previous\n',
    'play-pause\n',
    'next\n'
  ]);
  assert.equal(monitor.sendMediaKey('invalid'), null);
  monitor.stop();
});

test('monitor reports synchronous helper launch failures and schedules a recoverable restart', () => {
  const events = [];
  const monitor = new WindowsMediaSessionMonitor({
    platform: 'win32',
    spawnImpl: () => {
      throw new Error('launch failed');
    }
  });

  assert.equal(monitor.start((event) => events.push(event)), true);
  assert.deepEqual(events, [{ type: 'unavailable', message: 'launch failed' }]);
  assert.ok(monitor.restartTimer);
  monitor.stop();
  assert.equal(monitor.restartTimer, null);
});

test('monitor still kills the helper when closing stdin throws', () => {
  let child;
  const monitor = new WindowsMediaSessionMonitor({
    platform: 'win32',
    spawnImpl: () => {
      child = new FakeChild();
      child.stdin.end = () => {
        throw new Error('broken stdin');
      };
      return child;
    }
  });

  monitor.start(() => {});
  monitor.stop();
  assert.equal(child.killed, true);
});
