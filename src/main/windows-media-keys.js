const MEDIA_VIRTUAL_KEYS = {
  previous: '0xB1',
  'play-pause': '0xB3',
  next: '0xB0'
};

function buildMediaKeyPowerShellScript(command) {
  const virtualKey = MEDIA_VIRTUAL_KEYS[command];
  if (!virtualKey) {
    throw new Error('Unsupported system media command.');
  }

  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class SpotifyLiteMediaKey {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
"@
[SpotifyLiteMediaKey]::keybd_event([byte]${virtualKey}, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 35
[SpotifyLiteMediaKey]::keybd_event([byte]${virtualKey}, 0, 2, [UIntPtr]::Zero)
`;
}

async function sendWindowsMediaKey(command, {
  platform = process.platform,
  mediaSessionMonitor = null,
  runPowerShell,
  logger = console
} = {}) {
  if (platform !== 'win32') {
    throw new Error('System media keys are supported on Windows only.');
  }

  const script = buildMediaKeyPowerShellScript(command);
  const nativeCommand = mediaSessionMonitor?.sendMediaKey(command);
  if (nativeCommand) {
    try {
      await nativeCommand;
      return;
    } catch (error) {
      logger.error('Native media-key channel failed; using PowerShell fallback:', error);
    }
  }

  if (typeof runPowerShell !== 'function') {
    throw new Error('PowerShell media-key fallback is unavailable.');
  }
  await runPowerShell(script, 5000);
}

module.exports = {
  buildMediaKeyPowerShellScript,
  sendWindowsMediaKey
};
