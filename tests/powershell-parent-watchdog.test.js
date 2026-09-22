const assert = require('node:assert/strict');
const test = require('node:test');

const { wrapPowerShellWithParentWatchdog } = require('../src/main/powershell-parent-watchdog');

test('PowerShell wrapper watches the exact parent PID and preserves the command', () => {
  const script = wrapPowerShellWithParentWatchdog("Write-Output 'ready'", 4242);

  assert.match(script, /\$widgetsParentProcessId = 4242/);
  assert.match(script, /Register-ObjectEvent/);
  assert.match(script, /\[Environment\]::Exit\(0\)/);
  assert.match(script, /Write-Output 'ready'/);
});

test('PowerShell wrapper rejects invalid parent PIDs', () => {
  assert.throws(() => wrapPowerShellWithParentWatchdog('exit 0', 0), /Invalid PowerShell parent PID/);
  assert.throws(() => wrapPowerShellWithParentWatchdog('exit 0', 'not-a-pid'), /Invalid PowerShell parent PID/);
});
