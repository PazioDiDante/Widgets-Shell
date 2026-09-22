const DEFAULT_BATCH_TIMEOUT_MS = 20000;

function buildPnpDeviceBatchScript(devices) {
  const deviceIds = devices
    .map((device) => String(device?.id || '').trim())
    .filter(Boolean);
  const encodedDeviceIds = Buffer.from(JSON.stringify(deviceIds), 'utf8').toString('base64');

  return `
$ErrorActionPreference = 'SilentlyContinue'
$deviceIdsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDeviceIds}'))
$parsedDeviceIds = $deviceIdsJson | ConvertFrom-Json
$deviceIds = if ($parsedDeviceIds -is [System.Array]) { $parsedDeviceIds } else { @($parsedDeviceIds) }

$items = foreach ($deviceId in $deviceIds) {
  $device = Get-PnpDevice -InstanceId ([string]$deviceId) -ErrorAction SilentlyContinue
  $connected = [bool]($device -and $device.Status -eq 'OK')
  $batteryPercent = $null

  if ($connected) {
    $battery = Get-PnpDeviceProperty -InstanceId ([string]$deviceId) -KeyName '{49CD1F76-5626-4B17-A4E8-18B4AA1A2213} 10' -ErrorAction SilentlyContinue
    if ($battery -and $battery.Data -ne $null -and $battery.Data -ne '') {
      $batteryPercent = [int]$battery.Data
    }
  }

  [pscustomobject]@{
    id = [string]$deviceId
    connected = $connected
    batteryPercent = $batteryPercent
  }
}

$items | ConvertTo-Json -Depth 3 -Compress
`;
}

async function readPnpDeviceSnapshot(devices, {
  runPowerShell,
  normalizeBatteryPercent,
  timeoutMs = DEFAULT_BATCH_TIMEOUT_MS
}) {
  if (!devices.length) {
    return new Map();
  }

  const output = (await runPowerShell(buildPnpDeviceBatchScript(devices), timeoutMs)).trim();
  const parsed = output ? JSON.parse(output) : [];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const snapshot = new Map();

  for (const record of records) {
    const id = String(record?.id || '');
    if (!id) {
      continue;
    }

    snapshot.set(id, {
      connected: Boolean(record.connected),
      batteryPercent: normalizeBatteryPercent(record.batteryPercent)
    });
  }

  return snapshot;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

module.exports = {
  buildPnpDeviceBatchScript,
  mapWithConcurrency,
  readPnpDeviceSnapshot
};
