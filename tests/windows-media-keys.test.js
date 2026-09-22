const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMediaKeyPowerShellScript,
  sendWindowsMediaKey
} = require('../src/main/windows-media-keys');

test('media-key script maps only the three supported commands', () => {
  assert.match(buildMediaKeyPowerShellScript('previous'), /\[byte\]0xB1/);
  assert.match(buildMediaKeyPowerShellScript('play-pause'), /\[byte\]0xB3/);
  assert.match(buildMediaKeyPowerShellScript('next'), /\[byte\]0xB0/);
  assert.throws(() => buildMediaKeyPowerShellScript('invalid'), /Unsupported system media command/);
});

test('native media-key success avoids a PowerShell process', async () => {
  let powerShellCalls = 0;
  await sendWindowsMediaKey('next', {
    platform: 'win32',
    mediaSessionMonitor: { sendMediaKey: () => Promise.resolve() },
    runPowerShell: async () => {
      powerShellCalls += 1;
    }
  });

  assert.equal(powerShellCalls, 0);
});

test('native media-key failure falls back to the original PowerShell command', async () => {
  const calls = [];
  const logged = [];
  await sendWindowsMediaKey('play-pause', {
    platform: 'win32',
    mediaSessionMonitor: { sendMediaKey: () => Promise.reject(new Error('pipe closed')) },
    runPowerShell: async (script, timeoutMs) => calls.push({ script, timeoutMs }),
    logger: { error: (...args) => logged.push(args) }
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].script, /\[byte\]0xB3/);
  assert.equal(calls[0].timeoutMs, 5000);
  assert.equal(logged.length, 1);
});

test('an unavailable native helper uses PowerShell directly', async () => {
  let powerShellCalls = 0;
  await sendWindowsMediaKey('previous', {
    platform: 'win32',
    mediaSessionMonitor: { sendMediaKey: () => null },
    runPowerShell: async () => {
      powerShellCalls += 1;
    }
  });

  assert.equal(powerShellCalls, 1);
});
