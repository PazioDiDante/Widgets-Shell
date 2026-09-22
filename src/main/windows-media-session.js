const { spawn } = require('node:child_process');
const path = require('node:path');

const DEFAULT_HELPER_PATH = path.join(
  __dirname,
  '..',
  '..',
  'native',
  'windows-media-session',
  'windows-media-session-v3.exe'
);

class WindowsMediaSessionMonitor {
  constructor({
    spawnImpl = spawn,
    platform = process.platform,
    parentPid = process.pid,
    helperPath = DEFAULT_HELPER_PATH
  } = {}) {
    this.spawn = spawnImpl;
    this.platform = platform;
    this.parentPid = parentPid;
    this.helperPath = helperPath;
    this.child = null;
    this.stoppingChildren = new Set();
    this.restartTimer = null;
    this.stdoutBuffer = '';
    this.onEvent = null;
    this.stopped = true;
  }

  start(onEvent) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.stopped = false;

    if (this.platform !== 'win32') {
      return false;
    }

    if (!this.child) {
      this.launch();
    }

    return true;
  }

  stop() {
    this.stopped = true;
    this.stdoutBuffer = '';
    clearTimeout(this.restartTimer);
    this.restartTimer = null;

    const child = this.child;
    this.child = null;
    if (child) {
      this.stoppingChildren.add(child);
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill();
      } catch {
        this.stoppingChildren.delete(child);
      }
    }
  }

  sendMediaKey(command) {
    if (!['previous', 'play-pause', 'next'].includes(command)) {
      return null;
    }

    const input = this.child?.stdin;
    if (this.platform !== 'win32' || !input || input.destroyed || !input.writable) {
      return null;
    }

    return new Promise((resolve, reject) => {
      try {
        input.write(`${command}\n`, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  launch() {
    if (this.stopped || this.child || this.stoppingChildren.size) {
      return;
    }

    let child;
    try {
      child = this.spawn(this.helperPath, ['--parent-pid', String(this.parentPid)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      this.onEvent?.({ type: 'unavailable', message: error.message });
      this.scheduleRestart();
      return;
    }

    this.child = child;
    this.stdoutBuffer = '';

    child.stdout?.on('data', (chunk) => this.consumeStdout(chunk));
    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.onEvent?.({ type: 'unavailable', message });
      }
    });
    child.once('error', (error) => {
      if (this.child !== child || this.stopped) {
        return;
      }

      this.onEvent?.({ type: 'unavailable', message: error.message });
    });
    child.once('close', (code) => {
      this.stoppingChildren.delete(child);
      if (this.child === child) {
        this.child = null;
      }

      if (!this.stopped) {
        if (code && code !== 0) {
          this.onEvent?.({
            type: 'unavailable',
            message: `Windows media session listener exited with code ${code}.`
          });
        }
        this.scheduleRestart();
      }
    });
  }

  scheduleRestart() {
    if (this.stopped || this.child || this.restartTimer) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, 1000);
    this.restartTimer.unref?.();
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk.toString();
    if (this.stdoutBuffer.length > 1024 * 1024) {
      this.stdoutBuffer = '';
      this.onEvent?.({
        type: 'unavailable',
        message: 'Windows media helper output exceeded its safety limit.'
      });
      return;
    }

    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        this.onEvent?.(JSON.parse(trimmed));
      } catch {
        // The native helper writes one JSON object per line.
      }
    }
  }
}

module.exports = {
  DEFAULT_HELPER_PATH,
  WindowsMediaSessionMonitor
};
