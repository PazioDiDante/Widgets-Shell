const { spawn } = require('node:child_process');
const { wrapPowerShellWithParentWatchdog } = require('./powershell-parent-watchdog');

const DEFAULT_TIMEOUT_MS = 4000;

function buildDwmBatchScript(windows) {
  const commands = windows.map((window) => {
    const handle = String(window.handle || '');
    if (!/^\d+$/.test(handle)) {
      throw new Error(`Invalid native window handle: ${handle}`);
    }

    return [
      'Set-WidgetsWindowAttributes',
      `-windowHandle '${handle}'`,
      `-transparentDesktop $${window.transparentDesktop ? 'true' : 'false'}`,
      `-disableTransitions $${window.transitionsDisabled ? 'true' : 'false'}`
    ].join(' ');
  }).join('\n');

  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DwmApi {
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

  [DllImport("user32.dll")]
  public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);
}

[StructLayout(LayoutKind.Sequential)]
public struct AccentPolicy {
  public int AccentState;
  public int AccentFlags;
  public int GradientColor;
  public int AnimationId;
}

[StructLayout(LayoutKind.Sequential)]
public struct WindowCompositionAttributeData {
  public int Attribute;
  public IntPtr Data;
  public int SizeOfData;
}
"@

function Set-WidgetsWindowAttributes {
  param(
    [string]$windowHandle,
    [bool]$transparentDesktop,
    [bool]$disableTransitions
  )

  $hwnd = [IntPtr][Int64]$windowHandle

  if ($disableTransitions) {
    $transitionsForcedDisabled = 1
    [DwmApi]::DwmSetWindowAttribute($hwnd, 3, [ref]$transitionsForcedDisabled, 4) | Out-Null
  }

  $cornerPreference = if ($transparentDesktop) { 1 } else { 2 }
  [DwmApi]::DwmSetWindowAttribute($hwnd, 33, [ref]$cornerPreference, 4) | Out-Null

  if ($transparentDesktop) {
    $ncRenderingPolicy = 1
    [DwmApi]::DwmSetWindowAttribute($hwnd, 2, [ref]$ncRenderingPolicy, 4) | Out-Null

    $borderColor = -2
    [DwmApi]::DwmSetWindowAttribute($hwnd, 34, [ref]$borderColor, 4) | Out-Null
  }

  $accent = New-Object AccentPolicy
  $accent.AccentState = if ($transparentDesktop) { 0 } else { 4 }
  $accent.AccentFlags = if ($transparentDesktop) { 0 } else { 2 }
  $accent.GradientColor = if ($transparentDesktop) { 0x00000000 } else { 0x33201816 }
  $accent.AnimationId = 0
  $accentSize = [Runtime.InteropServices.Marshal]::SizeOf([type][AccentPolicy])
  $accentPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($accentSize)
  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($accent, $accentPtr, $false)
    $data = New-Object WindowCompositionAttributeData
    $data.Attribute = 19
    $data.Data = $accentPtr
    $data.SizeOfData = $accentSize
    [DwmApi]::SetWindowCompositionAttribute($hwnd, [ref]$data) | Out-Null
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($accentPtr)
  }
}

${commands}
`;
}

class DwmWindowEffects {
  constructor({
    spawnImpl = spawn,
    platform = process.platform,
    parentPid = process.pid,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    getNativeWindowHandle,
    logger = console
  } = {}) {
    this.spawn = spawnImpl;
    this.platform = platform;
    this.parentPid = parentPid;
    this.timeoutMs = timeoutMs;
    this.getNativeWindowHandle = getNativeWindowHandle;
    this.logger = logger;
    this.pendingWindows = new Map();
    this.flushImmediate = null;
    this.batchRunning = false;
    this.child = null;
    this.finishCurrentBatch = null;
    this.disposed = false;
  }

  apply(window, options = {}) {
    if (
      this.disposed
      || this.platform !== 'win32'
      || !window
      || window.isDestroyed()
      || typeof this.getNativeWindowHandle !== 'function'
    ) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let request = this.pendingWindows.get(window);
      if (!request) {
        request = { window, options: {}, resolvers: [] };
        this.pendingWindows.set(window, request);
      }

      request.options = {
        transparentDesktop: Boolean(options.transparentDesktop),
        transitionsDisabled: Boolean(options.transitionsDisabled)
      };
      request.resolvers.push(resolve);
      this.scheduleFlush();
    });
  }

  scheduleFlush() {
    if (this.disposed || this.batchRunning || this.flushImmediate) {
      return;
    }

    this.flushImmediate = setImmediate(() => {
      this.flushImmediate = null;
      void this.flush();
    });
  }

  async flush() {
    if (this.disposed || this.batchRunning || !this.pendingWindows.size) {
      return;
    }

    const batch = [...this.pendingWindows.values()];
    this.pendingWindows.clear();
    this.batchRunning = true;

    try {
      const windows = [];
      for (const request of batch) {
        if (request.window.isDestroyed()) {
          continue;
        }

        try {
          windows.push({
            handle: this.getNativeWindowHandle(request.window),
            ...request.options
          });
        } catch (error) {
          this.logger.error('Failed to read the native window handle:', error);
        }
      }

      if (windows.length) {
        await this.runBatch(windows);
      }
    } catch (error) {
      this.logger.error('Failed to apply DWM window attributes:', error);
    } finally {
      for (const request of batch) {
        request.resolvers.forEach((resolve) => resolve());
      }
      this.batchRunning = false;

      if (!this.disposed && this.pendingWindows.size) {
        this.scheduleFlush();
      }
    }
  }

  runBatch(windows) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          wrapPowerShellWithParentWatchdog(buildDwmBatchScript(windows), this.parentPid)
        ], {
          stdio: 'ignore',
          windowsHide: true
        });
      } catch (error) {
        this.logger.error('Failed to start DWM window attributes process:', error);
        resolve();
        return;
      }

      this.child = child;
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        if (this.child === child) {
          this.child = null;
          this.finishCurrentBatch = null;
        }
        resolve();
      };
      this.finishCurrentBatch = finish;
      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // The process may already have exited between the timeout and kill.
        }
        finish();
      }, this.timeoutMs);
      timeout.unref?.();

      child.once('error', (error) => {
        this.logger.error('Failed to apply DWM window attributes:', error);
        finish();
      });
      child.once('close', finish);
    });
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (this.flushImmediate) {
      clearImmediate(this.flushImmediate);
      this.flushImmediate = null;
    }

    for (const request of this.pendingWindows.values()) {
      request.resolvers.forEach((resolve) => resolve());
    }
    this.pendingWindows.clear();

    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // The process may already have exited during application shutdown.
      }
    }
    this.finishCurrentBatch?.();
  }
}

module.exports = {
  DwmWindowEffects,
  buildDwmBatchScript
};
