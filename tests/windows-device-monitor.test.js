const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPnpDeviceBatchScript,
  mapWithConcurrency,
  readPnpDeviceSnapshot
} = require('../src/main/windows-device-monitor');

test('PnP device script batches IDs and keeps them out of executable PowerShell text', () => {
  const deviceIds = [
    'BTHLE\\DEV_001122334455',
    "USB\\VID_1234'; Write-Output 'unexpected"
  ];
  const script = buildPnpDeviceBatchScript(deviceIds.map((id) => ({ id })));
  const encodedMatch = /FromBase64String\('([^']+)'\)/.exec(script);

  assert.ok(encodedMatch);
  assert.deepEqual(
    JSON.parse(Buffer.from(encodedMatch[1], 'base64').toString('utf8')),
    deviceIds
  );
  assert.equal(script.includes(deviceIds[1]), false);
  assert.equal((script.match(/Get-PnpDevice -InstanceId/g) || []).length, 1);
  assert.match(script, /Get-PnpDeviceProperty/);
  assert.match(script, /49CD1F76-5626-4B17-A4E8-18B4AA1A2213/);
});

test('PnP snapshot accepts a single PowerShell JSON object', async () => {
  let invocationCount = 0;
  const snapshot = await readPnpDeviceSnapshot([{ id: 'one' }], {
    runPowerShell: async () => {
      invocationCount += 1;
      return JSON.stringify({ id: 'one', connected: true, batteryPercent: 71 });
    },
    normalizeBatteryPercent: (value) => Number(value)
  });

  assert.equal(invocationCount, 1);
  assert.deepEqual(snapshot.get('one'), {
    connected: true,
    batteryPercent: 71
  });
});

test('PnP snapshot parses arrays and normalizes battery values', async () => {
  const snapshot = await readPnpDeviceSnapshot([{ id: 'one' }, { id: 'two' }], {
    runPowerShell: async () => JSON.stringify([
      { id: 'one', connected: true, batteryPercent: '52' },
      { id: 'two', connected: false, batteryPercent: null }
    ]),
    normalizeBatteryPercent: (value) => value === null ? null : Number(value)
  });

  assert.deepEqual([...snapshot], [
    ['one', { connected: true, batteryPercent: 52 }],
    ['two', { connected: false, batteryPercent: null }]
  ]);
});

test('concurrency mapper caps simultaneous work and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const releases = [];
  const items = [1, 2, 3, 4, 5];
  const mapping = mapWithConcurrency(items, 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return item * 10;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();

  assert.deepEqual(await mapping, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});
