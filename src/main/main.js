const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen, shell } = require('electron');
const chokidar = require('chokidar');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;
const { DemandDrivenResource } = require('./demand-driven-resource');
const { DwmWindowEffects } = require('./dwm-window-effects');
const { wrapPowerShellWithParentWatchdog } = require('./powershell-parent-watchdog');
const { SpotifyLiteService } = require('./spotify-lite');
const { StateSaveCoordinator } = require('./state-save-coordinator');
const { mapWithConcurrency, readPnpDeviceSnapshot } = require('./windows-device-monitor');
const { sendWindowsMediaKey: sendWindowsMediaKeyCommand } = require('./windows-media-keys');
const { DEFAULT_HELPER_PATH, WindowsMediaSessionMonitor } = require('./windows-media-session');
const { ensureVisibleBounds } = require('./window-bounds');

const { loadLocalSettings, saveLocalSettingsPatch } = require('./local-settings');
const settingsRootPath = path.join(__dirname, '..', '..');
const localSettings = loadLocalSettings(settingsRootPath);

const isDev = !app.isPackaged;
const widgetWindows = new Map();
const todoEditorWindowsReadyToClose = new WeakSet();
const notesWindowsReadyToClose = new WeakSet();
const transparentDesktopWindows = new WeakSet();
const windowsWithDisabledTransitions = new WeakSet();
let todoRootPath = path.resolve(localSettings.todoRootPath || path.join(app.getPath('documents'), 'Widgets Tasks'));
let todoTemplatePath = localSettings.todoTemplatePath ? path.resolve(localSettings.todoTemplatePath) : '';
const ignoredTodoFiles = new Set(['_Все дела.md', '_Дела.md']);
const todoDetailsHeadingPattern = /^###\s+(?:What needs to be done|Что нужно сделать)[ \t]*$/m;

let tray = null;
let menuWindow = null;
let dockerWindow = null;
let stateFilePath = null;
let notesFilePath = null;
let state = null;
let todoRefreshTimer = null;
let todoTreeReadInFlight = null;
let todoEditorWindow = null;
let todoEditorReadyPromise = null;
let spotifyLiteFooterVisible = false;
let resolveTodoEditorReady = null;
let todoEditorCurrentTaskId = null;
let todoEditorOpenRequest = null;
let todoEditorRequestId = 0;
let todoContextMenuWindow = null;
let todoContextMenuReadyPromise = null;
let resolveTodoContextMenuReady = null;
let todoContextMenuTaskId = null;
let todoContextMenuOpenRequest = null;
let todoContextMenuRequestId = 0;
let devicesContextMenuWindow = null;
let devicesContextMenuReadyPromise = null;
let resolveDevicesContextMenuReady = null;
let devicesContextMenuDeviceId = null;
let devicesContextMenuOpenRequest = null;
let devicesContextMenuRequestId = 0;
let devicesPickerWindow = null;
let devicesPickerReadyPromise = null;
let resolveDevicesPickerReady = null;
let devicesPickerOpenRequest = null;
let devicesPickerRequestId = 0;
let clockContextMenuWindow = null;
let clockContextMenuReadyPromise = null;
let resolveClockContextMenuReady = null;
let clockContextMenuOpenRequest = null;
let clockContextMenuRequestId = 0;
const desktopWidgetMouseHooks = new Map();
const managedNativeCommandChildren = new Set();
const managedPowerShellChildren = new Set();
const widgetIdsBeingRecreated = new Set();
let todoCreateWindow = null;
let todoCreateReadyPromise = null;
let resolveTodoCreateReady = null;
let todoCreateGroupId = null;
let todoCreateOpenRequest = null;
let todoCreateRequestId = 0;
let isQuitting = false;
const windowFirstShowState = new WeakMap();
let visualEffectsRefreshTimer = null;
let knownDevicesCache = null;
let knownDevicesReadInFlight = null;
let deviceMonitorCache = null;
let deviceMonitorReadInFlight = null;
let spotifyLiteService = null;
let windowsMediaSessionMonitor = null;
const knownDevicesCacheMs = 10000;
const deviceMonitorCacheMs = 15000;
const stateSaveCoordinator = new StateSaveCoordinator(writeWidgetState, { delayMs: 250 });
const todoWatcherController = new DemandDrivenResource(createTodoWatcher);

const WIDGETS = [
  {
    id: 'clock',
    title: 'Clock',
    defaultBounds: { width: 260, height: 150 },
    dockerSpan: 1
  },
  {
    id: 'notes',
    title: 'Notes',
    defaultBounds: { width: 320, height: 240 },
    dockerSpan: 1
  },
  {
    id: 'system',
    title: 'System',
    defaultBounds: { width: 300, height: 180 },
    dockerSpan: 1
  },
  {
    id: 'devices',
    title: 'Devices',
    defaultBounds: { width: 320, height: 220 },
    minBounds: { width: 220, height: 150 },
    dockerSpan: 1
  },
  {
    id: 'todo',
    title: 'Todo',
    defaultBounds: { width: 460, height: 560 },
    minBounds: { width: 360, height: 220 },
    dockerSpan: 1
  },
  {
    id: 'spotify-lite',
    title: 'Spotify Lite',
    defaultBounds: { width: 410, height: 184 },
    minBounds: { width: 300, height: 184 },
    dockerSpan: 2
  }
];

const SPOTIFY_LITE_COMPACT_HEIGHT = 184;
const SPOTIFY_LITE_MIN_WIDTH = 300;
const SPOTIFY_LITE_INTERFACE_HEIGHT = 160;
const SPOTIFY_LITE_FOOTER_HEIGHT = 24;
const WINDOW_PREPARATION_TIMEOUT_MS = 30000;

function defaultAppearance() {
  return {
    backgroundHue: 210,
    backgroundSaturation: 33,
    backgroundBrightness: 9,
    backgroundOpacity: 42
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function normalizeAppearance(appearance = {}) {
  const fallback = defaultAppearance();

  return {
    backgroundHue: clampNumber(appearance.backgroundHue, 0, 360, fallback.backgroundHue),
    backgroundSaturation: clampNumber(appearance.backgroundSaturation, 0, 100, fallback.backgroundSaturation),
    backgroundBrightness: clampNumber(appearance.backgroundBrightness, 0, 100, fallback.backgroundBrightness),
    backgroundOpacity: clampNumber(appearance.backgroundOpacity, 0, 100, fallback.backgroundOpacity)
  };
}

function defaultState() {
  return {
    autostart: false,
    appearance: defaultAppearance(),
    menu: {
      open: false
    },
    docker: {
      positions: {}
    },
    widgets: {}
  };
}

function ensureStateFile() {
  stateFilePath = path.join(app.getPath('userData'), 'widgets.json');
  notesFilePath = path.join(app.getPath('userData'), 'notes.txt');

  if (!fs.existsSync(notesFilePath)) {
    fs.mkdirSync(path.dirname(notesFilePath), { recursive: true });
    fs.writeFileSync(notesFilePath, '', 'utf8');
  }

  if (!fs.existsSync(stateFilePath)) {
    state = defaultState();
    saveWidgetState();
    return;
  }

  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    state = { ...defaultState(), ...JSON.parse(raw) };
    state.appearance = normalizeAppearance(state.appearance);
    state.menu = { ...defaultState().menu, ...(state.menu || {}) };
    state.docker = { ...defaultState().docker, ...(state.docker || {}) };
    state.docker.positions = state.docker.positions || {};
    state.widgets = state.widgets || {};
  } catch (error) {
    const backupPath = `${stateFilePath}.broken-${Date.now()}`;
    fs.copyFileSync(stateFilePath, backupPath);
    state = defaultState();
    saveWidgetState();
  }
}

function writeWidgetState() {
  if (!stateFilePath || !state) {
    return;
  }

  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

function saveWidgetState() {
  stateSaveCoordinator.writeNow();
}

function scheduleWidgetStateSave() {
  stateSaveCoordinator.schedule();
}

function getDisplayWorkAreaForBounds(bounds) {
  if (
    !bounds
    || !app.isReady()
    || !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
  ) {
    return null;
  }

  return screen.getDisplayMatching(bounds)?.workArea || null;
}

function getVisibleWindowBounds(bounds, sourceWorkArea) {
  if (!app.isReady()) {
    return bounds;
  }

  const displays = screen.getAllDisplays();
  return ensureVisibleBounds(
    bounds,
    displays.map((display) => display.workArea),
    sourceWorkArea,
    screen.getPrimaryDisplay()?.workArea
  );
}

function boundsEqual(first, second) {
  return first.x === second.x
    && first.y === second.y
    && first.width === second.width
    && first.height === second.height;
}

function ensureBrowserWindowVisible(window, sourceWorkArea) {
  if (!window || window.isDestroyed()) {
    return false;
  }

  const currentBounds = window.getBounds();
  const visibleBounds = getVisibleWindowBounds(currentBounds, sourceWorkArea);
  if (boundsEqual(currentBounds, visibleBounds)) {
    return false;
  }

  window.setBounds(visibleBounds, false);
  return true;
}

function restoreManagedWindowsToVisibleDisplays(sourceWorkArea = null) {
  if (menuWindow && !menuWindow.isDestroyed()) {
    ensureBrowserWindowVisible(menuWindow, sourceWorkArea || state.menu?.displayWorkArea);
    persistMenuWindowBounds({ defer: true });
  }

  if (dockerWindow && !dockerWindow.isDestroyed()) {
    ensureBrowserWindowVisible(dockerWindow, sourceWorkArea || state.docker?.displayWorkArea);
    persistDockerWindowBounds({ defer: true });
  }

  for (const [widgetId, window] of widgetWindows) {
    ensureBrowserWindowVisible(window, sourceWorkArea || state.widgets[widgetId]?.displayWorkArea);
    persistWindowBounds(widgetId, window, { defer: true });
  }
}

function getWidgetDefinition(widgetId) {
  return WIDGETS.find((widget) => widget.id === widgetId);
}

function getRendererUrl(kind, widgetId, extraParams = {}) {
  const htmlPath = path.join(__dirname, '..', 'renderer', 'index.html');
  const params = new URLSearchParams({ view: kind });

  if (widgetId) {
    params.set('widgetId', widgetId);
  }

  for (const [key, value] of Object.entries(extraParams)) {
    params.set(key, value);
  }

  return `file://${htmlPath}?${params.toString()}`;
}

function getWindowVisualOptions() {
  if (process.platform === 'win32') {
    return {};
  }

  if (process.platform === 'darwin') {
    return {
      vibrancy: 'under-window',
      visualEffectState: 'active'
    };
  }

  return {};
}

function getNativeWindowHandleDecimal(window) {
  const handle = window.getNativeWindowHandle();

  if (handle.length >= 8 && typeof handle.readBigUInt64LE === 'function') {
    return handle.readBigUInt64LE(0).toString();
  }

  return String(handle.readUInt32LE(0));
}

const dwmWindowEffects = new DwmWindowEffects({
  platform: process.platform,
  spawnImpl: spawn,
  getNativeWindowHandle: getNativeWindowHandleDecimal
});

function applyDwmWindowAttributes(window) {
  return dwmWindowEffects.apply(window, {
    transparentDesktop: transparentDesktopWindows.has(window),
    transitionsDisabled: windowsWithDisabledTransitions.has(window)
  });
}

function getOpenWindows() {
  const windows = [...widgetWindows.values()].filter((window) => !window.isDestroyed());

  if (dockerWindow && !dockerWindow.isDestroyed()) {
    windows.push(dockerWindow);
  }

  if (todoEditorWindow && !todoEditorWindow.isDestroyed()) {
    windows.push(todoEditorWindow);
  }

  if (todoContextMenuWindow && !todoContextMenuWindow.isDestroyed()) {
    windows.push(todoContextMenuWindow);
  }

  if (devicesContextMenuWindow && !devicesContextMenuWindow.isDestroyed()) {
    windows.push(devicesContextMenuWindow);
  }

  if (devicesPickerWindow && !devicesPickerWindow.isDestroyed()) {
    windows.push(devicesPickerWindow);
  }

  if (clockContextMenuWindow && !clockContextMenuWindow.isDestroyed()) {
    windows.push(clockContextMenuWindow);
  }

  if (todoCreateWindow && !todoCreateWindow.isDestroyed()) {
    windows.push(todoCreateWindow);
  }

  if (menuWindow && !menuWindow.isDestroyed()) {
    windows.push(menuWindow);
  }

  return windows;
}

function scheduleVisualEffectsRefresh() {
  if (process.platform !== 'win32') {
    return;
  }

  clearTimeout(visualEffectsRefreshTimer);
  visualEffectsRefreshTimer = setTimeout(() => {
    visualEffectsRefreshTimer = null;

    for (const window of getOpenWindows()) {
      if (!windowFirstShowState.has(window)) {
        void applyDwmWindowAttributes(window);
      }
    }
  }, 150);
}

function attachVisualEffectsRefreshEvents(window) {
  window.on('show', scheduleVisualEffectsRefresh);
  window.on('focus', scheduleVisualEffectsRefresh);
  window.on('blur', scheduleVisualEffectsRefresh);
}

async function applyWindowVisualEffects(window) {
  window.setSkipTaskbar(true);

  await applyDwmWindowAttributes(window);

  if (process.platform === 'darwin' && typeof window.setVibrancy === 'function') {
    window.setVibrancy('under-window');
  }
}

function prepareFirstShow(window, autoShow = true) {
  const showState = {
    readyToShow: false,
    rendererReady: false,
    revealing: false,
    autoShow,
    visualEffectsPromise: null,
    preparationTimeout: null
  };
  windowFirstShowState.set(window, showState);
  showState.preparationTimeout = setTimeout(() => {
    if (windowFirstShowState.get(window) !== showState) {
      return;
    }

    windowFirstShowState.delete(window);
    console.error('Window preparation timed out; destroying the hidden window.');
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }, WINDOW_PREPARATION_TIMEOUT_MS);
  showState.preparationTimeout.unref?.();
  window.once('closed', () => {
    clearTimeout(showState.preparationTimeout);
    if (windowFirstShowState.get(window) === showState) {
      windowFirstShowState.delete(window);
    }
  });
  showState.visualEffectsPromise = applyWindowVisualEffects(window).catch((error) => {
    console.error('Failed to prepare window visual effects:', error);
  });
}

function tryShowPreparedWindow(window) {
  const showState = windowFirstShowState.get(window);
  const transitionsDisabled = windowsWithDisabledTransitions.has(window);

  if (
    !showState
    || window.isDestroyed()
    || !showState.readyToShow
    || !showState.rendererReady
    || (!showState.autoShow && !transitionsDisabled)
    || showState.revealing
  ) {
    return;
  }

  showState.revealing = true;

  if (transitionsDisabled) {
    void showState.visualEffectsPromise.finally(() => {
      if (window.isDestroyed()) {
        return;
      }

      window.setOpacity(0);
      window.setIgnoreMouseEvents(true);
      window.setFocusable(false);
      window.showInactive();
      window.setSkipTaskbar(true);
      clearTimeout(showState.preparationTimeout);
      windowFirstShowState.delete(window);

      if (showState.autoShow) {
        revealPersistentWindow(window);
      }

      scheduleVisualEffectsRefresh();
    });
    return;
  }

  if (process.platform === 'win32') {
    window.setOpacity(0);
  }

  window.show();

  void showState.visualEffectsPromise.finally(() => {
    const revealDelay = process.platform === 'win32' ? 32 : 0;

    setTimeout(() => {
      if (window.isDestroyed()) {
        return;
      }

      if (process.platform === 'win32') {
        window.setOpacity(1);
      }

      window.focus();
      clearTimeout(showState.preparationTimeout);
      windowFirstShowState.delete(window);
      scheduleVisualEffectsRefresh();
    }, revealDelay);
  });
}

function revealPersistentWindow(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  window.setFocusable(true);
  window.setSkipTaskbar(true);
  window.setIgnoreMouseEvents(false);
  window.setOpacity(1);
  window.focus();
  window.setSkipTaskbar(true);
}

function concealPersistentWindow(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  window.setFocusable(false);
  window.setSkipTaskbar(true);
}

function showPreparedWindow(window) {
  const showState = windowFirstShowState.get(window);

  if (showState) {
    showState.autoShow = true;
    tryShowPreparedWindow(window);
    return;
  }

  if (windowsWithDisabledTransitions.has(window)) {
    revealPersistentWindow(window);
    scheduleVisualEffectsRefresh();
    return;
  }

  window.show();
  window.focus();
  scheduleVisualEffectsRefresh();
}

function markReadyToShow(window) {
  const showState = windowFirstShowState.get(window);

  if (!showState) {
    return;
  }

  showState.readyToShow = true;
  tryShowPreparedWindow(window);
}

function markRendererReady(window) {
  const showState = windowFirstShowState.get(window);

  if (!showState) {
    return;
  }

  showState.rendererReady = true;
  tryShowPreparedWindow(window);
}

function setAlwaysOnTop(widgetId, value) {
  const window = widgetWindows.get(widgetId);
  const widgetState = state.widgets[widgetId] || {};

  widgetState.alwaysOnTop = Boolean(value);
  state.widgets[widgetId] = widgetState;

  if (window && !window.isDestroyed()) {
    const alwaysOnTop = ['clock', 'spotify-lite'].includes(widgetId) && widgetState.desktopMode
      ? false
      : widgetState.alwaysOnTop;
    window.setAlwaysOnTop(alwaysOnTop, 'floating');
  }

  if (widgetId === 'todo') {
    if (todoEditorWindow && !todoEditorWindow.isDestroyed()) {
      todoEditorWindow.setAlwaysOnTop(widgetState.alwaysOnTop, 'floating');
    }

    if (todoContextMenuWindow && !todoContextMenuWindow.isDestroyed()) {
      todoContextMenuWindow.setAlwaysOnTop(widgetState.alwaysOnTop, 'floating');
    }

    if (todoCreateWindow && !todoCreateWindow.isDestroyed()) {
      todoCreateWindow.setAlwaysOnTop(widgetState.alwaysOnTop, 'floating');
    }
  }

  if (widgetId === 'devices') {
    if (devicesContextMenuWindow && !devicesContextMenuWindow.isDestroyed()) {
      devicesContextMenuWindow.setAlwaysOnTop(widgetState.alwaysOnTop, 'floating');
    }

    if (devicesPickerWindow && !devicesPickerWindow.isDestroyed()) {
      devicesPickerWindow.setAlwaysOnTop(widgetState.alwaysOnTop, 'floating');
    }
  }

  saveWidgetState();
}

function persistWindowBounds(widgetId, window, { defer = false } = {}) {
  if (!window || window.isDestroyed()) {
    return;
  }

  const widgetState = state.widgets[widgetId] || {};
  widgetState.bounds = window.getBounds();
  widgetState.displayWorkArea = getDisplayWorkAreaForBounds(widgetState.bounds);
  widgetState.open = true;
  state.widgets[widgetId] = widgetState;
  if (defer) {
    scheduleWidgetStateSave();
  } else {
    saveWidgetState();
  }
}

function setWidgetOpenState(widgetId, isOpen) {
  const widgetState = state.widgets[widgetId] || {};
  const open = Boolean(isOpen);
  if (widgetState.open === open) {
    return;
  }

  widgetState.open = open;
  state.widgets[widgetId] = widgetState;
  saveWidgetState();
}

function persistMenuWindowBounds({ defer = false } = {}) {
  if (!menuWindow || menuWindow.isDestroyed()) {
    return;
  }

  const bounds = menuWindow.getBounds();
  state.menu = {
    ...(state.menu || {}),
    bounds,
    displayWorkArea: getDisplayWorkAreaForBounds(bounds),
    open: true
  };
  if (defer) {
    scheduleWidgetStateSave();
  } else {
    saveWidgetState();
  }
}

function setMenuOpenState(isOpen) {
  const open = Boolean(isOpen);
  if (state.menu?.open === open) {
    return;
  }

  state.menu = {
    ...(state.menu || {}),
    open
  };
  saveWidgetState();
}

function getDockedWidgets() {
  return WIDGETS.filter((widget) => Boolean(state.widgets[widget.id]?.docked));
}

function dockerPositionsOverlap(first, firstSpan, second, secondSpan) {
  return first.row === second.row
    && first.col < second.col + secondSpan
    && second.col < first.col + firstSpan;
}

function normalizeDockerPosition(position) {
  return {
    row: Math.max(0, Math.floor(Number(position?.row) || 0)),
    col: Math.max(0, Math.floor(Number(position?.col) || 0))
  };
}

function ensureDockerPosition(widgetId) {
  const widget = getWidgetDefinition(widgetId);
  if (!widget) {
    return null;
  }

  state.docker = { positions: {}, ...(state.docker || {}) };
  state.docker.positions = state.docker.positions || {};
  const columns = 4;
  const span = widget.dockerSpan || 1;
  const occupied = getDockedWidgets()
    .filter((candidate) => candidate.id !== widgetId && state.docker.positions[candidate.id])
    .map((candidate) => ({
      position: normalizeDockerPosition(state.docker.positions[candidate.id]),
      span: candidate.dockerSpan || 1
    }));
  const stored = state.docker.positions[widgetId]
    ? normalizeDockerPosition(state.docker.positions[widgetId])
    : null;

  if (
    stored
    && !occupied.some((entry) => dockerPositionsOverlap(stored, span, entry.position, entry.span))
  ) {
    state.docker.positions[widgetId] = stored;
    return stored;
  }

  for (let row = 0; row < 1000; row += 1) {
    for (let col = 0; col + span <= columns; col += 1) {
      const candidate = { row, col };
      if (!occupied.some((entry) => dockerPositionsOverlap(candidate, span, entry.position, entry.span))) {
        state.docker.positions[widgetId] = candidate;
        return candidate;
      }
    }
  }

  const fallback = { row: occupied.length, col: 0 };
  state.docker.positions[widgetId] = fallback;
  return fallback;
}

function getDockerData() {
  const widgets = getDockedWidgets();
  widgets.forEach((widget) => ensureDockerPosition(widget.id));

  return {
    widgets: widgets.map((widget) => ({
      ...widget,
      state: state.widgets[widget.id] || {}
    })),
    positions: Object.fromEntries(widgets.map((widget) => [
      widget.id,
      normalizeDockerPosition(state.docker.positions[widget.id])
    ])),
    appearance: state.appearance
  };
}

function persistDockerWindowBounds({ defer = false } = {}) {
  if (!dockerWindow || dockerWindow.isDestroyed()) {
    return;
  }

  const bounds = dockerWindow.getBounds();
  state.docker = {
    ...(state.docker || {}),
    bounds,
    displayWorkArea: getDisplayWorkAreaForBounds(bounds),
    positions: state.docker?.positions || {}
  };
  if (defer) {
    scheduleWidgetStateSave();
  } else {
    saveWidgetState();
  }
}

function broadcastDockerState() {
  if (dockerWindow && !dockerWindow.isDestroyed()) {
    dockerWindow.webContents.send('docker:state-updated', getDockerData());
  }
}

function createDockerWindow() {
  if (!getDockedWidgets().length) {
    return null;
  }

  if (dockerWindow && !dockerWindow.isDestroyed()) {
    ensureBrowserWindowVisible(dockerWindow, state.docker?.displayWorkArea);
    persistDockerWindowBounds({ defer: true });
    dockerWindow.show();
    broadcastDockerState();
    scheduleVisualEffectsRefresh();
    return dockerWindow;
  }

  const storedBounds = state.docker?.bounds || { width: 400, height: 260 };
  const bounds = getVisibleWindowBounds(storedBounds, state.docker?.displayWorkArea);
  dockerWindow = new BrowserWindow({
    title: 'Docker',
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 194,
    minHeight: 104,
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const initialDockerBounds = dockerWindow.getBounds();
  state.docker = {
    ...(state.docker || {}),
    bounds: initialDockerBounds,
    displayWorkArea: getDisplayWorkAreaForBounds(initialDockerBounds),
    positions: state.docker?.positions || {}
  };
  scheduleWidgetStateSave();

  prepareFirstShow(dockerWindow);
  attachVisualEffectsRefreshEvents(dockerWindow);
  dockerWindow.loadURL(getRendererUrl('docker'));

  if (state.widgets['spotify-lite']?.docked) {
    void spotifyLiteService?.start();
  }

  dockerWindow.once('ready-to-show', () => {
    markReadyToShow(dockerWindow);
  });
  dockerWindow.on('moved', () => persistDockerWindowBounds({ defer: true }));
  dockerWindow.on('resized', () => persistDockerWindowBounds({ defer: true }));
  dockerWindow.on('close', (event) => {
    persistDockerWindowBounds({ defer: true });
    if (!isQuitting && getDockedWidgets().length) {
      event.preventDefault();
    }
  });
  dockerWindow.on('closed', () => {
    dockerWindow = null;
    syncTodoWatcher();
  });

  return dockerWindow;
}

function updateDockerWindow() {
  if (!getDockedWidgets().length) {
    if (dockerWindow && !dockerWindow.isDestroyed()) {
      const emptyDockerWindow = dockerWindow;
      setImmediate(() => {
        if (
          !getDockedWidgets().length
          && dockerWindow === emptyDockerWindow
          && !emptyDockerWindow.isDestroyed()
        ) {
          emptyDockerWindow.destroy();
        }
      });
    }
    return null;
  }

  return createDockerWindow();
}

function dockWidget(widgetId) {
  const widget = getWidgetDefinition(widgetId);
  if (!widget) {
    throw new Error(`Unknown widget: ${widgetId}`);
  }

  const widgetState = state.widgets[widgetId] || {};
  const window = widgetWindows.get(widgetId);
  if (window && !window.isDestroyed()) {
    widgetState.bounds = window.getBounds();
  }

  widgetState.open = false;
  widgetState.docked = true;
  state.widgets[widgetId] = widgetState;
  ensureDockerPosition(widgetId);
  saveWidgetState();
  updateDockerWindow();
  if (widgetId === 'todo') {
    syncTodoWatcher();
  }

  if (window && !window.isDestroyed()) {
    window.hide();
    setImmediate(() => {
      if (!window.isDestroyed() && state.widgets[widgetId]?.docked) {
        window.close();
      }
    });
  }

  return getDockerData();
}

function restoreDockedWidget(widgetId) {
  const widget = getWidgetDefinition(widgetId);
  if (!widget) {
    throw new Error(`Unknown widget: ${widgetId}`);
  }

  const widgetState = state.widgets[widgetId] || {};
  widgetState.docked = false;
  widgetState.open = false;
  state.widgets[widgetId] = widgetState;
  delete state.docker?.positions?.[widgetId];
  saveWidgetState();

  const window = createWidgetWindow(widgetId);
  updateDockerWindow();
  if (widgetId === 'todo') {
    syncTodoWatcher();
  }
  return window ? state.widgets[widgetId] : null;
}

function removeDockedWidget(widgetId) {
  const widgetState = state.widgets[widgetId] || {};
  widgetState.docked = false;
  widgetState.open = false;
  state.widgets[widgetId] = widgetState;
  delete state.docker?.positions?.[widgetId];
  saveWidgetState();
  updateDockerWindow();

  if (widgetId === 'todo') {
    syncTodoWatcher();
  }

  if (widgetId === 'spotify-lite' && !widgetWindows.has(widgetId)) {
    spotifyLiteService?.stop();
  }

  return widgetState;
}

function setDockerLayout(nextPositions) {
  const dockedIds = new Set(getDockedWidgets().map((widget) => widget.id));
  const positions = {};

  for (const [id, position] of Object.entries(nextPositions || {})) {
    if (dockedIds.has(id)) {
      positions[id] = normalizeDockerPosition(position);
    }
  }

  for (const id of dockedIds) {
    if (!positions[id]) {
      positions[id] = normalizeDockerPosition(state.docker?.positions?.[id]);
    }
  }

  state.docker = { ...(state.docker || {}), positions };
  saveWidgetState();
  return getDockerData();
}

function stopDesktopWidgetMouseHook(widgetId) {
  const hook = desktopWidgetMouseHooks.get(widgetId);
  desktopWidgetMouseHooks.delete(widgetId);

  if (hook?.child && !hook.child.killed) {
    hook.child.kill();
  }
}

function stopAllDesktopWidgetMouseHooks() {
  for (const widgetId of desktopWidgetMouseHooks.keys()) {
    stopDesktopWidgetMouseHook(widgetId);
  }
}

function startDesktopWidgetMouseHook(widgetId, window, { forceLegacy = false } = {}) {
  if (process.platform !== 'win32' || !widgetId || !window || window.isDestroyed()) {
    return;
  }

  const nativeHandle = getNativeWindowHandleDecimal(window);
  const existingHook = desktopWidgetMouseHooks.get(widgetId);
  if (
    existingHook?.child
    && !existingHook.child.killed
    && existingHook.nativeHandle === nativeHandle
  ) {
    return;
  }

  stopDesktopWidgetMouseHook(widgetId);
  let child;
  let backend = 'powershell';
  if (!forceLegacy && fs.existsSync(DEFAULT_HELPER_PATH)) {
    backend = 'native';
    child = spawn(DEFAULT_HELPER_PATH, [
      '--desktop-widget-hook',
      nativeHandle,
      '--parent-pid',
      String(process.pid)
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } else {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DesktopWidgetMouseHook {
  private const int WH_MOUSE_LL = 14;
  private const int WM_QUIT = 0x0012;
  private const int WM_RBUTTONDOWN = 0x0204;
  private const int WM_RBUTTONUP = 0x0205;
  private static IntPtr targetWindow;
  private static IntPtr hookHandle;
  private static HookProc hookProc = HandleMouse;

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT { public int left; public int top; public int right; public int bottom; }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSLLHOOKSTRUCT {
    public POINT pt;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSG {
    public IntPtr hwnd;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public POINT pt;
  }

  private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int hookId, HookProc callback, IntPtr module, uint threadId);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool UnhookWindowsHookEx(IntPtr hook);

  [DllImport("user32.dll")]
  private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);

  [DllImport("user32.dll")]
  private static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);

  [DllImport("user32.dll")]
  private static extern bool TranslateMessage(ref MSG message);

  [DllImport("user32.dll")]
  private static extern IntPtr DispatchMessage(ref MSG message);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr window, out RECT rect);

  [DllImport("user32.dll")]
  private static extern bool IsWindow(IntPtr window);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll")]
  private static extern IntPtr WindowFromPoint(POINT point);

  [DllImport("user32.dll")]
  private static extern IntPtr GetAncestor(IntPtr window, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, StringBuilder className, int maximumCount);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetModuleHandle(string moduleName);

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  public static void Run(long windowHandle) {
    targetWindow = new IntPtr(windowHandle);
    uint messageThread = GetCurrentThreadId();
    hookHandle = SetWindowsHookEx(WH_MOUSE_LL, hookProc, GetModuleHandle(null), 0);
    if (hookHandle == IntPtr.Zero) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    using (Timer watchdog = new Timer(_ => {
      if (!IsWindow(targetWindow)) {
        PostThreadMessage(messageThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
      }
    }, null, 500, 500)) {
      MSG message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
        TranslateMessage(ref message);
        DispatchMessage(ref message);
      }
    }

    UnhookWindowsHookEx(hookHandle);
    hookHandle = IntPtr.Zero;
  }

  private static IntPtr HandleMouse(int code, IntPtr message, IntPtr data) {
    int messageId = message.ToInt32();
    if (
      code >= 0
      && (messageId == WM_RBUTTONDOWN || messageId == WM_RBUTTONUP)
      && IsWindowVisible(targetWindow)
    ) {
      MSLLHOOKSTRUCT mouse = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(data);
      RECT bounds;
      if (
        GetWindowRect(targetWindow, out bounds)
        && mouse.pt.x >= bounds.left
        && mouse.pt.x < bounds.right
        && mouse.pt.y >= bounds.top
        && mouse.pt.y < bounds.bottom
        && IsDesktopPoint(mouse.pt)
      ) {
        if (messageId == WM_RBUTTONUP) {
          Console.WriteLine("DESKTOP_WIDGET_CONTEXT");
          Console.Out.Flush();
        }
        return new IntPtr(1);
      }
    }

    return CallNextHookEx(hookHandle, code, message, data);
  }

  private static bool IsDesktopPoint(POINT point) {
    IntPtr hitWindow = WindowFromPoint(point);
    if (hitWindow == targetWindow) {
      return true;
    }

    IntPtr rootWindow = GetAncestor(hitWindow, 2);
    StringBuilder className = new StringBuilder(128);
    GetClassName(rootWindow == IntPtr.Zero ? hitWindow : rootWindow, className, className.Capacity);
    string value = className.ToString();
    return value == "Progman" || value == "WorkerW";
  }
}
"@
[DesktopWidgetMouseHook]::Run([Int64]"${nativeHandle}")
`;
    child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      wrapPowerShellWithParentWatchdog(script)
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  const hook = { child, nativeHandle, output: '', backend };
  desktopWidgetMouseHooks.set(widgetId, hook);
  child.stdout.on('data', (chunk) => {
    if (desktopWidgetMouseHooks.get(widgetId) !== hook) {
      return;
    }

    hook.output += chunk.toString();
    if (hook.output.length > 64 * 1024) {
      hook.output = '';
      console.error(`${widgetId} mouse hook output exceeded its safety limit.`);
      return;
    }

    const lines = hook.output.split(/\r?\n/);
    hook.output = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() === 'DESKTOP_WIDGET_CONTEXT' && state.widgets[widgetId]?.desktopMode) {
        void openClockContextMenu(widgetId).catch((error) => {
          console.error(`Failed to open ${widgetId} context menu:`, error);
        });
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) {
      console.error(`${widgetId} mouse hook:`, message);
    }
  });
  child.once('error', (error) => {
    console.error(`${widgetId} mouse hook failed:`, error);
    if (hook.backend !== 'native' || desktopWidgetMouseHooks.get(widgetId) !== hook) {
      return;
    }

    desktopWidgetMouseHooks.delete(widgetId);
    const widgetWindow = widgetWindows.get(widgetId);
    if (widgetWindow && !widgetWindow.isDestroyed() && state.widgets[widgetId]?.desktopMode) {
      startDesktopWidgetMouseHook(widgetId, widgetWindow, { forceLegacy: true });
    }
  });
  child.once('close', () => {
    if (desktopWidgetMouseHooks.get(widgetId) !== hook) {
      return;
    }

    desktopWidgetMouseHooks.delete(widgetId);
    const widgetWindow = widgetWindows.get(widgetId);
    if (widgetWindow && !widgetWindow.isDestroyed() && state.widgets[widgetId]?.desktopMode) {
      if (hook.backend === 'native' && !isQuitting) {
        startDesktopWidgetMouseHook(widgetId, widgetWindow, { forceLegacy: true });
        return;
      }

      widgetWindow.setIgnoreMouseEvents(false);
    }
  });
}

async function moveDesktopWidgetWindowToBottom(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  window.setAlwaysOnTop(false);
  if (process.platform !== 'win32') {
    window.blur();
    return;
  }

  const nativeHandle = getNativeWindowHandleDecimal(window);
  if (fs.existsSync(DEFAULT_HELPER_PATH)) {
    try {
      await runWindowsNativeHelper([
        '--move-window-bottom',
        nativeHandle,
        '--parent-pid',
        String(process.pid)
      ], 5000);
      return;
    } catch (error) {
      console.error('Native window-order helper failed; using PowerShell fallback:', error);
    }
  }

  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DesktopWidgetWindowOrder {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(
    IntPtr hWnd,
    IntPtr hWndInsertAfter,
    int x,
    int y,
    int cx,
    int cy,
    uint flags
  );
}
"@
[DesktopWidgetWindowOrder]::SetWindowPos(
  [IntPtr]::new(${nativeHandle}),
  [IntPtr]::new(1),
  0,
  0,
  0,
  0,
  0x0013
) | Out-Null
`;

  await runPowerShell(script, 5000);
}

function applyClockWindowMode(window) {
  if (!window || window.isDestroyed()) {
    return Promise.resolve();
  }

  const widgetState = state.widgets.clock || {};
  const desktopMode = Boolean(widgetState.desktopMode);
  return applyDesktopWidgetWindowMode('clock', window, desktopMode, Boolean(widgetState.alwaysOnTop));
}

function applySpotifyLiteWindowMode(window) {
  if (!window || window.isDestroyed()) {
    return Promise.resolve();
  }

  const widgetState = state.widgets['spotify-lite'] || {};
  const desktopMode = Boolean(widgetState.desktopMode);
  return applyDesktopWidgetWindowMode('spotify-lite', window, desktopMode, Boolean(widgetState.alwaysOnTop));
}

function applyDesktopWidgetWindowMode(widgetId, window, desktopMode, alwaysOnTop) {
  if (desktopMode) {
    transparentDesktopWindows.add(window);
  } else {
    transparentDesktopWindows.delete(window);
  }
  window.setResizable(!desktopMode);
  window.setMovable(!desktopMode);
  window.setFocusable(!desktopMode);
  window.setSkipTaskbar(true);
  window.setHasShadow(false);
  window.setAlwaysOnTop(desktopMode ? false : alwaysOnTop, 'floating');
  if (desktopMode && process.platform === 'win32') {
    window.setIgnoreMouseEvents(true, { forward: true });
    startDesktopWidgetMouseHook(widgetId, window);
  } else {
    window.setIgnoreMouseEvents(false);
    stopDesktopWidgetMouseHook(widgetId);
  }
  const visualEffectsPromise = applyDwmWindowAttributes(window);

  if (desktopMode) {
    window.blur();
    setTimeout(() => {
      void moveDesktopWidgetWindowToBottom(window).catch((error) => {
        console.error(`Failed to move ${widgetId} below other windows:`, error);
      });
    }, 40);
  }
  return visualEffectsPromise;
}

async function recreateWidgetWindow(widgetId) {
  const previousWindow = widgetWindows.get(widgetId);
  if (!previousWindow || previousWindow.isDestroyed()) {
    return createWidgetWindow(widgetId);
  }

  persistWindowBounds(widgetId, previousWindow);
  widgetIdsBeingRecreated.add(widgetId);
  try {
    await new Promise((resolve) => {
      previousWindow.once('closed', resolve);
      previousWindow.destroy();
    });

    if (isQuitting) {
      return null;
    }

    state.widgets[widgetId] = {
      ...(state.widgets[widgetId] || {}),
      open: true
    };
    saveWidgetState();
    return createWidgetWindow(widgetId);
  } finally {
    widgetIdsBeingRecreated.delete(widgetId);
  }
}

async function setClockDesktopMode(enabled) {
  const widgetState = state.widgets.clock || {};
  const previousDesktopMode = Boolean(widgetState.desktopMode);
  const desktopMode = Boolean(enabled);
  widgetState.desktopMode = desktopMode;
  state.widgets.clock = widgetState;
  saveWidgetState();

  let window = widgetWindows.get('clock');
  if (window && !window.isDestroyed()) {
    if (previousDesktopMode && !desktopMode) {
      window = await recreateWidgetWindow('clock');
    } else {
      await applyClockWindowMode(window);
    }
  }

  return {
    desktopMode: widgetState.desktopMode,
    bounds: window && !window.isDestroyed() ? window.getBounds() : widgetState.bounds || null
  };
}

async function setSpotifyLiteDesktopMode(enabled) {
  const widgetState = state.widgets['spotify-lite'] || {};
  const previousDesktopMode = Boolean(widgetState.desktopMode);
  const desktopMode = Boolean(enabled);
  widgetState.desktopMode = desktopMode;
  state.widgets['spotify-lite'] = widgetState;
  if (desktopMode) {
    spotifyLiteFooterVisible = false;
  }
  saveWidgetState();

  let window = widgetWindows.get('spotify-lite');
  if (window && !window.isDestroyed()) {
    if (previousDesktopMode && !desktopMode) {
      window = await recreateWidgetWindow('spotify-lite');
    } else {
      await applySpotifyLiteWindowMode(window);
      syncSpotifyLiteSizeLimits(window);
      persistWindowBounds('spotify-lite', window);
    }
  }

  return {
    desktopMode: widgetState.desktopMode,
    expanded: Boolean(widgetState.expanded),
    bounds: window && !window.isDestroyed() ? window.getBounds() : widgetState.bounds || null
  };
}

function getSpotifyLiteWindowHeight(width, expanded) {
  const baseHeight = expanded
    ? Math.max(460, Math.round(width) + SPOTIFY_LITE_INTERFACE_HEIGHT)
    : SPOTIFY_LITE_COMPACT_HEIGHT;

  const desktopMode = Boolean(state.widgets['spotify-lite']?.desktopMode);
  return baseHeight + (!desktopMode && spotifyLiteFooterVisible ? SPOTIFY_LITE_FOOTER_HEIGHT : 0);
}

function syncSpotifyLiteSizeLimits(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  const widgetState = state.widgets['spotify-lite'] || {};
  const bounds = window.getBounds();
  const targetHeight = getSpotifyLiteWindowHeight(bounds.width, Boolean(widgetState.expanded));
  const [, currentMinimumHeight] = window.getMinimumSize();
  const [, currentMaximumHeight] = window.getMaximumSize();

  if (bounds.height === targetHeight
    && currentMinimumHeight === targetHeight
    && currentMaximumHeight === targetHeight) {
    return;
  }

  window.setMinimumSize(SPOTIFY_LITE_MIN_WIDTH, 120);
  window.setMaximumSize(10000, 10000);
  window.setBounds({ ...bounds, height: targetHeight });
  window.setMinimumSize(SPOTIFY_LITE_MIN_WIDTH, targetHeight);
  window.setMaximumSize(10000, targetHeight);
}

function setSpotifyLiteExpanded(expanded) {
  const widgetState = state.widgets['spotify-lite'] || {};
  widgetState.expanded = Boolean(expanded);
  state.widgets['spotify-lite'] = widgetState;

  const window = widgetWindows.get('spotify-lite');
  if (window && !window.isDestroyed()) {
    syncSpotifyLiteSizeLimits(window);
    persistWindowBounds('spotify-lite', window);
  } else {
    saveWidgetState();
  }

  return {
    expanded: widgetState.expanded,
    bounds: window && !window.isDestroyed() ? window.getBounds() : widgetState.bounds || null
  };
}

function setSpotifyLiteFooterVisible(visible) {
  const nextVisible = !state.widgets['spotify-lite']?.desktopMode && Boolean(visible);
  if (spotifyLiteFooterVisible === nextVisible) {
    return widgetWindows.get('spotify-lite')?.getBounds() || null;
  }

  spotifyLiteFooterVisible = nextVisible;
  const window = widgetWindows.get('spotify-lite');
  if (window && !window.isDestroyed()) {
    syncSpotifyLiteSizeLimits(window);
    persistWindowBounds('spotify-lite', window);
    return window.getBounds();
  }

  return null;
}

function createWidgetWindow(widgetId) {
  const widget = getWidgetDefinition(widgetId);

  if (!widget) {
    throw new Error(`Unknown widget: ${widgetId}`);
  }

  const existingWindow = widgetWindows.get(widgetId);
  if (existingWindow && !existingWindow.isDestroyed()) {
    ensureBrowserWindowVisible(existingWindow, state.widgets[widgetId]?.displayWorkArea);
    persistWindowBounds(widgetId, existingWindow, { defer: true });
    setWidgetOpenState(widgetId, true);
    if (widgetId === 'todo') {
      syncTodoWatcher();
    }
    if (['clock', 'spotify-lite'].includes(widgetId) && state.widgets[widgetId]?.desktopMode) {
      existingWindow.showInactive();
      void moveDesktopWidgetWindowToBottom(existingWindow).catch(() => {});
    } else {
      existingWindow.show();
      existingWindow.focus();
    }
    scheduleVisualEffectsRefresh();
    return existingWindow;
  }

  const widgetState = state.widgets[widgetId] || {};
  const desktopMode = ['clock', 'spotify-lite'].includes(widgetId) && Boolean(widgetState.desktopMode);
  const storedBounds = widgetState.bounds || widget.defaultBounds;
  const sizedBounds = widgetId === 'spotify-lite'
    ? {
      ...storedBounds,
      height: getSpotifyLiteWindowHeight(storedBounds.width, Boolean(widgetState.expanded))
    }
    : storedBounds;
  const bounds = getVisibleWindowBounds(sizedBounds, widgetState.displayWorkArea);
  const window = new BrowserWindow({
    title: widget.title,
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: widget.minBounds?.width || 180,
    minHeight: widgetId === 'spotify-lite' ? bounds.height : widget.minBounds?.height || 120,
    ...(widgetId === 'spotify-lite'
      ? { maxWidth: 10000, maxHeight: bounds.height }
      : {}),
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: !desktopMode,
    movable: !desktopMode,
    focusable: !desktopMode,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: desktopMode ? false : Boolean(widgetState.alwaysOnTop),
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  prepareFirstShow(window);
  attachVisualEffectsRefreshEvents(window);
  widgetWindows.set(widgetId, window);
  if (widgetId === 'todo') {
    syncTodoWatcher();
  }

  const initialWidgetBounds = window.getBounds();
  state.widgets[widgetId] = {
    ...widgetState,
    bounds: initialWidgetBounds,
    displayWorkArea: getDisplayWorkAreaForBounds(initialWidgetBounds),
    open: true,
    alwaysOnTop: Boolean(widgetState.alwaysOnTop)
  };
  saveWidgetState();
  if (widgetId === 'clock') {
    void applyClockWindowMode(window);
  } else if (widgetId === 'spotify-lite') {
    void applySpotifyLiteWindowMode(window);
  }

  window.loadURL(getRendererUrl('widget', widgetId));

  if (widgetId === 'spotify-lite') {
    void spotifyLiteService?.start();
  }

  window.once('ready-to-show', () => {
    markReadyToShow(window);
  });
  window.on('show', () => {
    window.setSkipTaskbar(true);
    if (['clock', 'spotify-lite'].includes(widgetId) && state.widgets[widgetId]?.desktopMode) {
      void moveDesktopWidgetWindowToBottom(window).catch(() => {});
    }
  });

  window.on('moved', () => persistWindowBounds(widgetId, window, { defer: true }));
  window.on('will-resize', (event, _newBounds, details) => {
    if (widgetId === 'spotify-lite' && ['top', 'bottom'].includes(details.edge)) {
      event.preventDefault();
    }
  });
  window.on('resized', () => {
    if (widgetId === 'spotify-lite') {
      syncSpotifyLiteSizeLimits(window);
    }

    persistWindowBounds(widgetId, window, { defer: true });
  });

  window.on('close', (event) => {
    if (
      widgetId === 'notes'
      && !isQuitting
      && !state.widgets[widgetId]?.docked
      && !notesWindowsReadyToClose.has(window)
    ) {
      event.preventDefault();
      window.webContents.send('notes:close-requested');
      return;
    }

    persistWindowBounds(widgetId, window, { defer: true });
    state.widgets[widgetId].open = isQuitting;
    saveWidgetState();
  });

  window.on('closed', () => {
    const beingRecreated = widgetIdsBeingRecreated.has(widgetId);
    if (widgetWindows.get(widgetId) === window) {
      widgetWindows.delete(widgetId);
    }

    if (widgetId === 'spotify-lite') {
      stopDesktopWidgetMouseHook(widgetId);
      if (!beingRecreated && !widgetWindows.has('clock')) {
        destroyClockContextMenuWindow();
      }
      if (!beingRecreated && !state.widgets[widgetId]?.docked) {
        spotifyLiteService?.stop();
        spotifyLiteFooterVisible = false;
      }
    }

    if (widgetId === 'todo') {
      destroyTodoEditorWindow();
      destroyTodoContextMenuWindow();
      destroyTodoCreateWindow();
      syncTodoWatcher();
    }

    if (widgetId === 'devices') {
      destroyDevicesContextMenuWindow();
      destroyDevicesPickerWindow();
    }

    if (widgetId === 'clock') {
      stopDesktopWidgetMouseHook(widgetId);
      if (!beingRecreated && !widgetWindows.has('spotify-lite')) {
        destroyClockContextMenuWindow();
      }
    }
  });

  if (widgetId === 'todo') {
    void ensureTodoContextMenuWindow();
  }

  if (widgetId === 'devices') {
    void ensureDevicesContextMenuWindow();
  }

  if (widgetId === 'clock') {
    void ensureClockContextMenuWindow();
  }

  return window;
}

function ensureTodoEditorWindow() {
  if (todoEditorWindow && !todoEditorWindow.isDestroyed()) {
    return todoEditorReadyPromise;
  }

  const width = 380;
  const height = 260;
  const todoWindow = widgetWindows.get('todo');
  const todoBounds = todoWindow && !todoWindow.isDestroyed() ? todoWindow.getBounds() : null;
  const window = new BrowserWindow({
    title: 'Todo editor',
    width,
    height,
    x: todoBounds ? todoBounds.x + Math.round((todoBounds.width - width) / 2) : undefined,
    y: todoBounds ? todoBounds.y + Math.round((todoBounds.height - height) / 2) : undefined,
    minWidth: 300,
    minHeight: 180,
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: Boolean(state.widgets.todo?.alwaysOnTop),
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  todoEditorWindow = window;
  todoEditorCurrentTaskId = null;
  todoEditorOpenRequest = null;
  todoEditorReadyPromise = new Promise((resolve) => {
    resolveTodoEditorReady = resolve;
  });

  windowsWithDisabledTransitions.add(window);
  prepareFirstShow(window, false);
  attachVisualEffectsRefreshEvents(window);
  window.loadURL(getRendererUrl('todo-editor'));

  window.once('ready-to-show', () => {
    markReadyToShow(window);
  });

  window.on('close', (event) => {
    if (isQuitting || todoEditorWindowsReadyToClose.has(window)) {
      return;
    }

    event.preventDefault();
    window.webContents.send('todo:editor-close-requested');
  });

  window.on('closed', () => {
    if (todoEditorWindow === window) {
      todoEditorWindow = null;
      todoEditorCurrentTaskId = null;
      todoEditorOpenRequest = null;
      resolveTodoEditorReady?.(false);
      resolveTodoEditorReady = null;
      todoEditorReadyPromise = null;
    }
  });

  return todoEditorReadyPromise;
}

function destroyTodoEditorWindow() {
  if (!todoEditorWindow || todoEditorWindow.isDestroyed()) {
    return;
  }

  todoEditorWindowsReadyToClose.add(todoEditorWindow);
  todoEditorWindow.close();
}

function getPopupWindowPosition(window, cursorPosition, size = window.getSize()) {
  const [width, height] = size;
  const workArea = screen.getDisplayNearestPoint(cursorPosition).workArea;
  const right = workArea.x + workArea.width;
  const bottom = workArea.y + workArea.height;
  const preferredX = cursorPosition.x + width <= right ? cursorPosition.x : cursorPosition.x - width;
  const preferredY = cursorPosition.y + height <= bottom ? cursorPosition.y : cursorPosition.y - height;

  return [
    Math.min(Math.max(preferredX, workArea.x), right - width),
    Math.min(Math.max(preferredY, workArea.y), bottom - height)
  ];
}

async function openTodoTaskEditor(taskId) {
  const normalizedTaskId = String(taskId || '');
  const cursorPosition = screen.getCursorScreenPoint();
  const [editorReady, filePath, details] = await Promise.all([
    ensureTodoEditorWindow(),
    resolveTodoTaskFile(normalizedTaskId),
    getTodoTaskDetails(normalizedTaskId)
  ]);

  if (!editorReady || !todoEditorWindow || todoEditorWindow.isDestroyed()) {
    throw new Error('Todo editor window is not available.');
  }

  const requestId = ++todoEditorRequestId;
  todoEditorCurrentTaskId = normalizedTaskId;
  todoEditorOpenRequest = { requestId, cursorPosition };
  todoEditorWindow.webContents.send('todo:editor-load-task', {
    requestId,
    taskId: normalizedTaskId,
    taskTitle: toTodoTitle(path.basename(filePath)),
    details
  });

  return true;
}

function showTodoEditorWindow(requestId, sender) {
  if (
    !todoEditorWindow
    || todoEditorWindow.isDestroyed()
    || todoEditorWindow.webContents !== sender
    || todoEditorOpenRequest?.requestId !== requestId
  ) {
    return false;
  }

  const [x, y] = getPopupWindowPosition(todoEditorWindow, todoEditorOpenRequest.cursorPosition);
  todoEditorWindow.setPosition(x, y);
  showPreparedWindow(todoEditorWindow);
  return true;
}

function hideTodoEditorWindow(sender) {
  if (!todoEditorWindow || todoEditorWindow.isDestroyed() || todoEditorWindow.webContents !== sender) {
    return false;
  }

  concealPersistentWindow(todoEditorWindow);
  return true;
}

function ensureTodoContextMenuWindow() {
  if (todoContextMenuWindow && !todoContextMenuWindow.isDestroyed()) {
    return todoContextMenuReadyPromise;
  }

  const window = new BrowserWindow({
    title: 'Todo menu',
    width: 150,
    height: 82,
    minWidth: 140,
    minHeight: 44,
    maxWidth: 220,
    maxHeight: 100,
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: Boolean(state.widgets.todo?.alwaysOnTop),
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  todoContextMenuWindow = window;
  todoContextMenuTaskId = null;
  todoContextMenuOpenRequest = null;
  todoContextMenuReadyPromise = new Promise((resolve) => {
    resolveTodoContextMenuReady = resolve;
  });

  windowsWithDisabledTransitions.add(window);
  prepareFirstShow(window, false);
  attachVisualEffectsRefreshEvents(window);
  window.loadURL(getRendererUrl('todo-menu'));

  window.once('ready-to-show', () => {
    markReadyToShow(window);
  });

  window.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    concealPersistentWindow(window);
  });

  window.on('closed', () => {
    if (todoContextMenuWindow === window) {
      todoContextMenuWindow = null;
      todoContextMenuTaskId = null;
      todoContextMenuOpenRequest = null;
      resolveTodoContextMenuReady?.(false);
      resolveTodoContextMenuReady = null;
      todoContextMenuReadyPromise = null;
    }
  });

  return todoContextMenuReadyPromise;
}

function destroyTodoContextMenuWindow() {
  if (todoContextMenuWindow && !todoContextMenuWindow.isDestroyed()) {
    todoContextMenuWindow.destroy();
  }
}

async function openTodoContextMenu(target) {
  const { kind, id, title } = target;
  const cursorPosition = screen.getCursorScreenPoint();
  const menuReady = await ensureTodoContextMenuWindow();

  if (!menuReady || !todoContextMenuWindow || todoContextMenuWindow.isDestroyed()) {
    throw new Error('Todo context menu is not available.');
  }

  concealPersistentWindow(todoContextMenuWindow);
  const requestId = ++todoContextMenuRequestId;
  todoContextMenuTaskId = kind === 'task' ? id : null;
  todoContextMenuOpenRequest = { requestId, cursorPosition, kind };
  todoContextMenuWindow.webContents.send('todo:menu-load-target', {
    requestId,
    kind,
    id,
    title
  });

  return true;
}

async function openTodoTaskContextMenu(taskId) {
  const normalizedTaskId = String(taskId || '');
  const filePath = await resolveTodoTaskFile(normalizedTaskId);
  return openTodoContextMenu({
    kind: 'task',
    id: normalizedTaskId,
    title: toTodoTitle(path.basename(filePath))
  });
}

async function openTodoGroupContextMenu(groupId) {
  const normalizedGroupId = String(groupId || '');
  const directoryPath = await resolveTodoGroupDirectory(normalizedGroupId);
  return openTodoContextMenu({
    kind: 'group',
    id: normalizedGroupId,
    title: path.basename(directoryPath)
  });
}

function showTodoContextMenu(requestId, sender) {
  if (
    !todoContextMenuWindow
    || todoContextMenuWindow.isDestroyed()
    || todoContextMenuWindow.webContents !== sender
    || todoContextMenuOpenRequest?.requestId !== requestId
  ) {
    return false;
  }

  const menuSize = todoContextMenuOpenRequest.kind === 'group' ? [170, 47] : [150, 82];
  const [width, height] = menuSize;
  const [x, y] = getPopupWindowPosition(
    todoContextMenuWindow,
    todoContextMenuOpenRequest.cursorPosition,
    menuSize
  );
  todoContextMenuWindow.setBounds({ x, y, width, height }, false);
  const menuWindow = todoContextMenuWindow;
  const expectedRequestId = todoContextMenuOpenRequest.requestId;

  setTimeout(() => {
    if (
      todoContextMenuOpenRequest?.requestId === expectedRequestId
      && todoContextMenuWindow === menuWindow
      && !menuWindow.isDestroyed()
    ) {
      showPreparedWindow(menuWindow);
    }
  }, 24);
  return true;
}

function hideTodoContextMenu(sender) {
  if (
    !todoContextMenuWindow
    || todoContextMenuWindow.isDestroyed()
    || todoContextMenuWindow.webContents !== sender
  ) {
    return false;
  }

  concealPersistentWindow(todoContextMenuWindow);
  return true;
}

function ensureDevicesContextMenuWindow() {
  if (devicesContextMenuWindow && !devicesContextMenuWindow.isDestroyed()) {
    return devicesContextMenuReadyPromise;
  }

  const window = new BrowserWindow({
    title: 'Devices menu',
    width: 132,
    height: 47,
    minWidth: 120,
    minHeight: 44,
    maxWidth: 180,
    maxHeight: 70,
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: Boolean(state.widgets.devices?.alwaysOnTop),
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  devicesContextMenuWindow = window;
  devicesContextMenuDeviceId = null;
  devicesContextMenuOpenRequest = null;
  devicesContextMenuReadyPromise = new Promise((resolve) => {
    resolveDevicesContextMenuReady = resolve;
  });

  windowsWithDisabledTransitions.add(window);
  prepareFirstShow(window, false);
  attachVisualEffectsRefreshEvents(window);
  window.loadURL(getRendererUrl('devices-menu'));

  window.once('ready-to-show', () => {
    markReadyToShow(window);
  });

  window.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    concealPersistentWindow(window);
  });

  window.on('closed', () => {
    if (devicesContextMenuWindow === window) {
      devicesContextMenuWindow = null;
      devicesContextMenuDeviceId = null;
      devicesContextMenuOpenRequest = null;
      resolveDevicesContextMenuReady?.(false);
      resolveDevicesContextMenuReady = null;
      devicesContextMenuReadyPromise = null;
    }
  });

  return devicesContextMenuReadyPromise;
}

function destroyDevicesContextMenuWindow() {
  if (devicesContextMenuWindow && !devicesContextMenuWindow.isDestroyed()) {
    devicesContextMenuWindow.destroy();
  }
}

async function openDevicesContextMenu(deviceId) {
  const normalizedDeviceId = String(deviceId || '');
  const savedDevice = getSavedDeviceList().find((device) => device.id === normalizedDeviceId);

  if (!savedDevice) {
    throw new Error('Device was not found.');
  }

  const cursorPosition = screen.getCursorScreenPoint();
  const menuReady = await ensureDevicesContextMenuWindow();

  if (!menuReady || !devicesContextMenuWindow || devicesContextMenuWindow.isDestroyed()) {
    throw new Error('Devices context menu is not available.');
  }

  const requestId = ++devicesContextMenuRequestId;
  devicesContextMenuDeviceId = normalizedDeviceId;
  devicesContextMenuOpenRequest = { requestId, cursorPosition };
  devicesContextMenuWindow.webContents.send('devices:menu-load-target', {
    requestId,
    id: normalizedDeviceId,
    title: savedDevice.name
  });

  return true;
}

function showDevicesContextMenu(requestId, sender) {
  if (
    !devicesContextMenuWindow
    || devicesContextMenuWindow.isDestroyed()
    || devicesContextMenuWindow.webContents !== sender
    || devicesContextMenuOpenRequest?.requestId !== requestId
  ) {
    return false;
  }

  const menuSize = [132, 47];
  const [width, height] = menuSize;
  const [x, y] = getPopupWindowPosition(
    devicesContextMenuWindow,
    devicesContextMenuOpenRequest.cursorPosition,
    menuSize
  );
  devicesContextMenuWindow.setBounds({ x, y, width, height }, false);
  showPreparedWindow(devicesContextMenuWindow);
  return true;
}

function hideDevicesContextMenu(sender) {
  if (
    !devicesContextMenuWindow
    || devicesContextMenuWindow.isDestroyed()
    || devicesContextMenuWindow.webContents !== sender
  ) {
    return false;
  }

  concealPersistentWindow(devicesContextMenuWindow);
  return true;
}

function ensureClockContextMenuWindow() {
  if (clockContextMenuWindow && !clockContextMenuWindow.isDestroyed()) {
    return clockContextMenuReadyPromise;
  }

  const window = new BrowserWindow({
    title: 'Clock menu',
    width: 150,
    height: 47,
    minWidth: 130,
    minHeight: 44,
    maxWidth: 200,
    maxHeight: 70,
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  clockContextMenuWindow = window;
  clockContextMenuOpenRequest = null;
  clockContextMenuReadyPromise = new Promise((resolve) => {
    resolveClockContextMenuReady = resolve;
  });

  windowsWithDisabledTransitions.add(window);
  prepareFirstShow(window, false);
  attachVisualEffectsRefreshEvents(window);
  window.loadURL(getRendererUrl('clock-menu'));

  window.once('ready-to-show', () => {
    markReadyToShow(window);
  });
  window.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    concealPersistentWindow(window);
  });
  window.on('closed', () => {
    if (clockContextMenuWindow === window) {
      clockContextMenuWindow = null;
      clockContextMenuOpenRequest = null;
      resolveClockContextMenuReady?.(false);
      resolveClockContextMenuReady = null;
      clockContextMenuReadyPromise = null;
    }
  });

  return clockContextMenuReadyPromise;
}

function destroyClockContextMenuWindow() {
  if (clockContextMenuWindow && !clockContextMenuWindow.isDestroyed()) {
    clockContextMenuWindow.destroy();
  }
}

async function openClockContextMenu(widgetId = 'clock') {
  if (!['clock', 'spotify-lite'].includes(widgetId) || !state.widgets[widgetId]?.desktopMode) {
    return false;
  }

  const menuReady = await ensureClockContextMenuWindow();
  if (!menuReady || !clockContextMenuWindow || clockContextMenuWindow.isDestroyed()) {
    throw new Error('Clock context menu is not available.');
  }

  concealPersistentWindow(clockContextMenuWindow);
  const requestId = ++clockContextMenuRequestId;
  clockContextMenuOpenRequest = {
    requestId,
    widgetId,
    cursorPosition: screen.getCursorScreenPoint()
  };
  clockContextMenuWindow.webContents.send('clock:menu-load', { requestId, widgetId });
  return true;
}

function showClockContextMenu(requestId, sender) {
  if (
    !clockContextMenuWindow
    || clockContextMenuWindow.isDestroyed()
    || clockContextMenuWindow.webContents !== sender
    || clockContextMenuOpenRequest?.requestId !== requestId
  ) {
    return false;
  }

  const menuSize = [150, 47];
  const [x, y] = getPopupWindowPosition(
    clockContextMenuWindow,
    clockContextMenuOpenRequest.cursorPosition,
    menuSize
  );
  clockContextMenuWindow.setBounds({ x, y, width: menuSize[0], height: menuSize[1] }, false);
  showPreparedWindow(clockContextMenuWindow);
  return true;
}

function hideClockContextMenu(sender) {
  if (
    !clockContextMenuWindow
    || clockContextMenuWindow.isDestroyed()
    || clockContextMenuWindow.webContents !== sender
  ) {
    return false;
  }

  concealPersistentWindow(clockContextMenuWindow);
  return true;
}

async function editClockFromContextMenu(sender) {
  if (
    !clockContextMenuWindow
    || clockContextMenuWindow.isDestroyed()
    || clockContextMenuWindow.webContents !== sender
  ) {
    return false;
  }

  concealPersistentWindow(clockContextMenuWindow);
  const widgetId = clockContextMenuOpenRequest?.widgetId || 'clock';
  if (widgetId === 'spotify-lite') {
    await setSpotifyLiteDesktopMode(false);
  } else {
    await setClockDesktopMode(false);
  }
  return true;
}

function ensureDevicesPickerWindow() {
  if (devicesPickerWindow && !devicesPickerWindow.isDestroyed()) {
    return devicesPickerReadyPromise;
  }

  const window = new BrowserWindow({
    title: 'Devices picker',
    width: 280,
    height: 340,
    minWidth: 220,
    minHeight: 120,
    maxWidth: 340,
    maxHeight: 420,
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: Boolean(state.widgets.devices?.alwaysOnTop),
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  devicesPickerWindow = window;
  devicesPickerOpenRequest = null;
  devicesPickerReadyPromise = new Promise((resolve) => {
    resolveDevicesPickerReady = resolve;
  });

  windowsWithDisabledTransitions.add(window);
  prepareFirstShow(window, false);
  attachVisualEffectsRefreshEvents(window);
  window.loadURL(getRendererUrl('devices-picker'));

  window.once('ready-to-show', () => {
    markReadyToShow(window);
  });

  window.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    concealPersistentWindow(window);
  });

  window.on('closed', () => {
    if (devicesPickerWindow === window) {
      devicesPickerWindow = null;
      devicesPickerOpenRequest = null;
      resolveDevicesPickerReady?.(false);
      resolveDevicesPickerReady = null;
      devicesPickerReadyPromise = null;
    }
  });

  return devicesPickerReadyPromise;
}

function destroyDevicesPickerWindow() {
  if (devicesPickerWindow && !devicesPickerWindow.isDestroyed()) {
    devicesPickerWindow.destroy();
  }
}

async function openDevicesPickerWindow() {
  const cursorPosition = screen.getCursorScreenPoint();
  const pickerReady = await ensureDevicesPickerWindow();

  if (!pickerReady || !devicesPickerWindow || devicesPickerWindow.isDestroyed()) {
    throw new Error('Devices picker is not available.');
  }

  const requestId = ++devicesPickerRequestId;
  devicesPickerOpenRequest = { requestId, cursorPosition };
  devicesPickerWindow.webContents.send('devices:picker-load', { requestId });
  return true;
}

function showDevicesPickerWindow(requestId, sender) {
  if (
    !devicesPickerWindow
    || devicesPickerWindow.isDestroyed()
    || devicesPickerWindow.webContents !== sender
    || devicesPickerOpenRequest?.requestId !== requestId
  ) {
    return false;
  }

  const menuSize = [280, 340];
  const [width, height] = menuSize;
  const [x, y] = getPopupWindowPosition(
    devicesPickerWindow,
    devicesPickerOpenRequest.cursorPosition,
    menuSize
  );
  devicesPickerWindow.setBounds({ x, y, width, height }, false);
  showPreparedWindow(devicesPickerWindow);
  return true;
}

function hideDevicesPickerWindow(sender) {
  if (
    !devicesPickerWindow
    || devicesPickerWindow.isDestroyed()
    || devicesPickerWindow.webContents !== sender
  ) {
    return false;
  }

  concealPersistentWindow(devicesPickerWindow);
  return true;
}

function ensureTodoCreateWindow() {
  if (todoCreateWindow && !todoCreateWindow.isDestroyed()) {
    return todoCreateReadyPromise;
  }

  const window = new BrowserWindow({
    title: 'Create todo',
    width: 380,
    height: 300,
    minWidth: 300,
    minHeight: 220,
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: Boolean(state.widgets.todo?.alwaysOnTop),
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  todoCreateWindow = window;
  todoCreateGroupId = null;
  todoCreateOpenRequest = null;
  todoCreateReadyPromise = new Promise((resolve) => {
    resolveTodoCreateReady = resolve;
  });

  prepareFirstShow(window, false);
  attachVisualEffectsRefreshEvents(window);
  window.loadURL(getRendererUrl('todo-create'));

  window.once('ready-to-show', () => {
    markReadyToShow(window);
  });

  window.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    window.webContents.send('todo:create-close-requested');
  });

  window.on('closed', () => {
    if (todoCreateWindow === window) {
      todoCreateWindow = null;
      todoCreateGroupId = null;
      todoCreateOpenRequest = null;
      resolveTodoCreateReady?.(false);
      resolveTodoCreateReady = null;
      todoCreateReadyPromise = null;
    }
  });

  return todoCreateReadyPromise;
}

function destroyTodoCreateWindow() {
  if (todoCreateWindow && !todoCreateWindow.isDestroyed()) {
    todoCreateWindow.destroy();
  }
}

async function openTodoCreateWindow(groupId) {
  const normalizedGroupId = String(groupId || '');
  const cursorPosition = screen.getCursorScreenPoint();
  const [createReady, directoryPath] = await Promise.all([
    ensureTodoCreateWindow(),
    resolveTodoGroupDirectory(normalizedGroupId)
  ]);

  if (!createReady || !todoCreateWindow || todoCreateWindow.isDestroyed()) {
    throw new Error('Todo creation window is not available.');
  }

  const requestId = ++todoCreateRequestId;
  todoCreateGroupId = normalizedGroupId;
  todoCreateOpenRequest = { requestId, cursorPosition };
  todoCreateWindow.webContents.send('todo:create-load-group', {
    requestId,
    groupId: normalizedGroupId,
    groupTitle: path.basename(directoryPath)
  });

  return true;
}

function showTodoCreateWindow(requestId, sender) {
  if (
    !todoCreateWindow
    || todoCreateWindow.isDestroyed()
    || todoCreateWindow.webContents !== sender
    || todoCreateOpenRequest?.requestId !== requestId
  ) {
    return false;
  }

  const [x, y] = getPopupWindowPosition(todoCreateWindow, todoCreateOpenRequest.cursorPosition);
  todoCreateWindow.setPosition(x, y);
  showPreparedWindow(todoCreateWindow);
  return true;
}

function hideTodoCreateWindow(sender) {
  if (!todoCreateWindow || todoCreateWindow.isDestroyed() || todoCreateWindow.webContents !== sender) {
    return false;
  }

  todoCreateWindow.hide();
  return true;
}

function createMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) {
    ensureBrowserWindowVisible(menuWindow, state.menu?.displayWorkArea);
    persistMenuWindowBounds({ defer: true });
    setMenuOpenState(true);
    menuWindow.show();
    menuWindow.focus();
    scheduleVisualEffectsRefresh();
    return menuWindow;
  }

  const storedBounds = state.menu?.bounds || { width: 360, height: 460 };
  const bounds = getVisibleWindowBounds(storedBounds, state.menu?.displayWorkArea);
  menuWindow = new BrowserWindow({
    title: 'Widgets',
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 320,
    minHeight: 320,
    frame: false,
    roundedCorners: true,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    ...getWindowVisualOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const initialMenuBounds = menuWindow.getBounds();
  state.menu = {
    ...(state.menu || {}),
    bounds: initialMenuBounds,
    displayWorkArea: getDisplayWorkAreaForBounds(initialMenuBounds)
  };
  scheduleWidgetStateSave();

  prepareFirstShow(menuWindow);
  attachVisualEffectsRefreshEvents(menuWindow);
  setMenuOpenState(true);
  menuWindow.loadURL(getRendererUrl('menu'));

  menuWindow.once('ready-to-show', () => {
    markReadyToShow(menuWindow);
  });

  menuWindow.on('moved', () => persistMenuWindowBounds({ defer: true }));
  menuWindow.on('resized', () => persistMenuWindowBounds({ defer: true }));

  menuWindow.on('close', () => {
    persistMenuWindowBounds({ defer: true });
    state.menu.open = isQuitting;
    saveWidgetState();
  });

  menuWindow.on('closed', () => {
    menuWindow = null;
  });

  return menuWindow;
}

function restoreWidgetState() {
  for (const widget of WIDGETS) {
    if (state.widgets[widget.id]?.open && !state.widgets[widget.id]?.docked) {
      createWidgetWindow(widget.id);
    }
  }
}

function restoreDockerState() {
  if (getDockedWidgets().length) {
    createDockerWindow();
  }
}

function restoreMenuState() {
  if (state.menu?.open) {
    createMenuWindow();
  }
}

function setAutostart(enabled) {
  state.autostart = Boolean(enabled);
  app.setLoginItemSettings({
    openAtLogin: state.autostart,
    path: process.execPath,
    args: isDev ? [app.getAppPath()] : []
  });
  saveWidgetState();
}

function compareNames(a, b) {
  return a.localeCompare(b, ['ru', 'en'], {
    numeric: true,
    sensitivity: 'base'
  });
}

function isMarkdownTaskFile(entry) {
  return entry.isFile() && path.extname(entry.name).toLowerCase() === '.md' && !ignoredTodoFiles.has(entry.name);
}

function toTodoTitle(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

function getRelativeTodoId(fullPath) {
  const relativePath = path.relative(todoRootPath, fullPath);
  return relativePath ? relativePath.replaceAll(path.sep, '/') : 'root';
}

async function readTodoDirectory(directoryPath) {
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  const directoryEntries = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => compareNames(a.name, b.name));
  const fileEntries = entries
    .filter(isMarkdownTaskFile)
    .sort((a, b) => compareNames(a.name, b.name));

  const groups = [];

  for (const entry of directoryEntries) {
    groups.push(await readTodoDirectory(path.join(directoryPath, entry.name)));
  }

  return {
    id: getRelativeTodoId(directoryPath),
    name: path.basename(directoryPath),
    path: directoryPath,
    tasks: fileEntries.map((entry) => {
      const filePath = path.join(directoryPath, entry.name);

      return {
        id: getRelativeTodoId(filePath),
        title: toTodoTitle(entry.name),
        path: filePath
      };
    }),
    groups
  };
}

function countTodoTasks(group) {
  return group.tasks.length + group.groups.reduce((total, child) => total + countTodoTasks(child), 0);
}

async function getTodoTree() {
  if (todoTreeReadInFlight) {
    return todoTreeReadInFlight;
  }

  todoTreeReadInFlight = (async () => {
    try {
      await fsp.access(todoRootPath);
      const group = await readTodoDirectory(todoRootPath);

      return {
        rootPath: todoRootPath,
        error: null,
        group,
        totalTasks: countTodoTasks(group)
      };
    } catch (error) {
      return {
        rootPath: todoRootPath,
        error: error.code === 'ENOENT' ? 'Todo folder was not found.' : error.message,
        group: null,
        totalTasks: 0
      };
    } finally {
      todoTreeReadInFlight = null;
    }
  })();

  return todoTreeReadInFlight;
}

function resolveTodoPath(relativeId) {
  const normalizedRelativePath = relativeId === 'root'
    ? ''
    : String(relativeId || '').replaceAll('/', path.sep);
  const resolvedPath = path.resolve(todoRootPath, normalizedRelativePath);
  const resolvedRootPath = path.resolve(todoRootPath);

  if (resolvedPath !== resolvedRootPath && !resolvedPath.startsWith(`${resolvedRootPath}${path.sep}`)) {
    throw new Error('Todo path is outside of the todo root.');
  }

  return resolvedPath;
}

async function resolveTodoTaskFile(taskId) {
  const filePath = resolveTodoPath(taskId);
  const stats = await fsp.stat(filePath).catch(() => null);

  if (!stats?.isFile()) {
    throw new Error('Todo task file was not found.');
  }

  if (path.extname(filePath).toLowerCase() !== '.md' || ignoredTodoFiles.has(path.basename(filePath))) {
    throw new Error('Only todo Markdown files can be edited.');
  }

  return filePath;
}

async function resolveTodoGroupDirectory(groupId) {
  const directoryPath = resolveTodoPath(groupId);
  const stats = await fsp.stat(directoryPath).catch(() => null);

  if (!stats?.isDirectory()) {
    throw new Error('Todo group folder was not found.');
  }

  return directoryPath;
}

function findTodoDetailsSection(markdown) {
  const heading = todoDetailsHeadingPattern.exec(markdown) || /^#[ \t]+\S.*$/m.exec(markdown);

  if (!heading) {
    throw new Error('The task note needs a title heading or a "What needs to be done" section.');
  }

  const headingEnd = heading.index + heading[0].length;
  const headingLineBreak = /^\r?\n/.exec(markdown.slice(headingEnd));
  const contentStart = headingEnd + (headingLineBreak?.[0].length || 0);
  const remainingMarkdown = markdown.slice(contentStart);
  const nextHeading = /^(#{1,3})[ \t]+\S.*$/m.exec(remainingMarkdown);

  return {
    headingEnd,
    contentStart,
    contentEnd: nextHeading ? contentStart + nextHeading.index : markdown.length
  };
}

function cleanTodoDetailsText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^\n+|\n+$/g, '');
}

function replaceTodoDetailsSection(markdown, details) {
  const section = findTodoDetailsSection(markdown);
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const normalizedDetails = cleanTodoDetailsText(String(details || '')).replaceAll('\n', newline);
  const suffix = markdown.slice(section.contentEnd);
  let replacement = newline;

  if (normalizedDetails) {
    replacement += `${normalizedDetails}${newline}`;
  }

  if (suffix) {
    replacement += newline;
  }

  return {
    markdown: `${markdown.slice(0, section.headingEnd)}${replacement}${suffix}`,
    details: normalizedDetails
  };
}

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeTodoFileTitle(title) {
  const trimmedTitle = String(title || '').trim();
  const fileTitle = trimmedTitle.replace(/\.md$/i, '').trim();

  if (!fileTitle) {
    throw new Error('Введите название заметки.');
  }

  if (/[<>:"/\\|?*\u0000-\u001f]/.test(fileTitle) || /[. ]$/.test(fileTitle)) {
    throw new Error('Название содержит недопустимые для файла символы.');
  }

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(fileTitle)) {
    throw new Error('Это название зарезервировано Windows.');
  }

  return fileTitle;
}

async function getTodoTaskDetails(taskId) {
  const filePath = await resolveTodoTaskFile(taskId);
  const markdown = await fsp.readFile(filePath, 'utf8');
  const section = findTodoDetailsSection(markdown);

  return cleanTodoDetailsText(markdown.slice(section.contentStart, section.contentEnd));
}

async function saveTodoTaskDetails(taskId, details) {
  const filePath = await resolveTodoTaskFile(taskId);
  const markdown = await fsp.readFile(filePath, 'utf8');
  const updated = replaceTodoDetailsSection(markdown, details);
  await fsp.writeFile(filePath, updated.markdown, 'utf8');

  return updated.details;
}

async function createTodoTask(groupId, title, details) {
  const directoryPath = await resolveTodoGroupDirectory(groupId);
  const fileTitle = normalizeTodoFileTitle(title);
  const filePath = path.join(directoryPath, `${fileTitle}.md`);
  let created;

  if (todoTemplatePath) {
    const template = await fsp.readFile(todoTemplatePath, 'utf8');
    const preparedTemplate = template
      .replace(/<%\*[\s\S]*?%>/g, '')
      .replace(/<%\s*tp\.file\.title\s*%>/g, JSON.stringify(fileTitle))
      .replace(/<%\s*tp\.date\.now\(["']YYYY-MM-DD["']\)\s*%>/g, formatLocalDate());
    created = replaceTodoDetailsSection(preparedTemplate, details);
  } else {
    const normalizedDetails = cleanTodoDetailsText(String(details || ''));
    created = {
      markdown: `# ${fileTitle}\n${normalizedDetails ? `\n${normalizedDetails}\n` : ''}`,
      details: normalizedDetails
    };
  }

  try {
    await fsp.writeFile(filePath, created.markdown, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('Заметка с таким названием уже существует.');
    }

    throw error;
  }

  const tree = await getTodoTree();
  await sendTodoTreeUpdate(tree);
  return {
    id: getRelativeTodoId(filePath),
    title: fileTitle
  };
}

async function deleteTodoTask(taskId) {
  const normalizedTaskId = String(taskId || '');
  const filePath = await resolveTodoTaskFile(normalizedTaskId);
  await fsp.unlink(filePath);

  if (
    todoEditorCurrentTaskId === normalizedTaskId
    && todoEditorWindow
    && !todoEditorWindow.isDestroyed()
  ) {
    todoEditorCurrentTaskId = null;
    todoEditorWindow.webContents.send('todo:editor-task-deleted', normalizedTaskId);
  }

  if (todoContextMenuTaskId === normalizedTaskId) {
    todoContextMenuTaskId = null;
  }

  const tree = await getTodoTree();
  await sendTodoTreeUpdate(tree);
  return true;
}

async function openTodoTask(taskId) {
  const filePath = await resolveTodoTaskFile(taskId);

  if (!todoTemplatePath) {
    const openError = await shell.openPath(filePath);

    if (openError) {
      throw new Error(`Unable to open the task note: ${openError}`);
    }

    return true;
  }

  const uriPath = filePath.replaceAll(path.sep, '/');
  const uri = `obsidian://open?path=${encodeURIComponent(uriPath)}`;

  try {
    await shell.openExternal(uri);
    return true;
  } catch (protocolError) {
    const executablePaths = [
      'C:\\Program Files\\Obsidian\\Obsidian.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Obsidian', 'Obsidian.exe')
    ];

    for (const executablePath of executablePaths) {
      const executableExists = await fsp.access(executablePath).then(() => true, () => false);

      if (!executableExists) {
        continue;
      }

      const child = spawn(executablePath, [uri], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return true;
    }

    throw new Error(`Unable to open Obsidian: ${protocolError.message}`);
  }
}

async function configureTodoSettings(ownerWindow) {
  const templateDescription = todoTemplatePath || 'Plain Markdown (no template)';
  const options = {
    type: 'question',
    title: 'Todo settings',
    message: 'Configure Todo storage',
    detail: `Task folder:\n${todoRootPath}\n\nTemplate:\n${templateDescription}`,
    buttons: ['Choose folder', 'Choose template', 'Use plain Markdown', 'Cancel'],
    defaultId: 0,
    cancelId: 3,
    noLink: true
  };
  const selection = ownerWindow && !ownerWindow.isDestroyed()
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options);

  if (selection.response === 3) {
    return getTodoTree();
  }

  if (selection.response === 0) {
    const openOptions = {
      title: 'Choose Todo folder',
      defaultPath: todoRootPath,
      properties: ['openDirectory', 'createDirectory']
    };
    const result = ownerWindow && !ownerWindow.isDestroyed()
      ? await dialog.showOpenDialog(ownerWindow, openOptions)
      : await dialog.showOpenDialog(openOptions);

    if (result.canceled || !result.filePaths[0]) {
      return getTodoTree();
    }

    todoRootPath = path.resolve(result.filePaths[0]);
    saveLocalSettingsPatch(settingsRootPath, { todoRootPath });
  } else if (selection.response === 1) {
    const openOptions = {
      title: 'Choose Todo template',
      defaultPath: todoTemplatePath || todoRootPath,
      properties: ['openFile'],
      filters: [
        { name: 'Markdown and text files', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    };
    const result = ownerWindow && !ownerWindow.isDestroyed()
      ? await dialog.showOpenDialog(ownerWindow, openOptions)
      : await dialog.showOpenDialog(openOptions);

    if (result.canceled || !result.filePaths[0]) {
      return getTodoTree();
    }

    todoTemplatePath = path.resolve(result.filePaths[0]);
    saveLocalSettingsPatch(settingsRootPath, { todoTemplatePath });
  } else {
    todoTemplatePath = '';
    saveLocalSettingsPatch(settingsRootPath, { todoTemplatePath: '' });
  }

  todoTreeReadInFlight = null;
  await closeTodoWatcher();
  syncTodoWatcher();
  const tree = await getTodoTree();
  await sendTodoTreeUpdate(tree);
  return tree;
}

async function moveTodoTask(taskId, targetGroupId) {
  const sourcePath = resolveTodoPath(taskId);
  const targetDirectoryPath = resolveTodoPath(targetGroupId);
  const sourceStats = await fsp.stat(sourcePath).catch(() => null);

  if (!sourceStats?.isFile()) {
    throw new Error('Todo task file was not found.');
  }

  if (path.extname(sourcePath).toLowerCase() !== '.md' || ignoredTodoFiles.has(path.basename(sourcePath))) {
    throw new Error('Only todo Markdown files can be moved.');
  }

  const targetDirectoryStats = await fsp.stat(targetDirectoryPath).catch(() => null);

  if (!targetDirectoryStats?.isDirectory()) {
    throw new Error('Target todo group was not found.');
  }

  const targetPath = path.join(targetDirectoryPath, path.basename(sourcePath));

  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return getTodoTree();
  }

  const targetExists = await fsp.access(targetPath).then(() => true, () => false);

  if (targetExists) {
    throw new Error('A task with this filename already exists in the target group.');
  }

  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }

    await fsp.copyFile(sourcePath, targetPath);
    await fsp.unlink(sourcePath);
  }

  const movedTaskId = getRelativeTodoId(targetPath);

  if (
    todoEditorCurrentTaskId === taskId
    && todoEditorWindow
    && !todoEditorWindow.isDestroyed()
  ) {
    todoEditorCurrentTaskId = movedTaskId;
    todoEditorWindow.webContents.send('todo:editor-task-moved', movedTaskId);
  }

  const tree = await getTodoTree();
  await sendTodoTreeUpdate(tree);
  return tree;
}

function broadcastAppearance() {
  const windows = getOpenWindows();

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('app:appearance-updated', state.appearance);
    }
  }
}

function setAppearance(nextAppearance) {
  state.appearance = normalizeAppearance({
    ...state.appearance,
    ...nextAppearance
  });
  saveWidgetState();
  broadcastAppearance();
  scheduleVisualEffectsRefresh();
  return state.appearance;
}

async function getNotesContent() {
  try {
    return await fsp.readFile(notesFilePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

async function saveNotesContent(content) {
  const text = String(content ?? '');
  await fsp.mkdir(path.dirname(notesFilePath), { recursive: true });
  await fsp.writeFile(notesFilePath, text, 'utf8');
  return text;
}

function runPowerShell(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      wrapPowerShellWithParentWatchdog(script)
    ], {
      windowsHide: true
    });
    managedPowerShellChildren.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      reject(new Error('Windows device query timed out.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', (error) => {
      managedPowerShellChildren.delete(child);

      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.once('close', (code) => {
      managedPowerShellChildren.delete(child);

      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `Windows device query failed with code ${code}.`));
        return;
      }

      resolve(stdout);
    });
  });
}

function runWindowsNativeHelper(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(DEFAULT_HELPER_PATH, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    managedNativeCommandChildren.add(child);
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      reject(new Error('Native Windows helper timed out.'));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', (error) => {
      managedNativeCommandChildren.delete(child);
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.once('close', (code) => {
      managedNativeCommandChildren.delete(child);
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Native Windows helper failed with code ${code}.`));
        return;
      }

      resolve();
    });
  });
}

function stopAllManagedCommandProcesses() {
  for (const child of managedPowerShellChildren) {
    try {
      child.kill();
    } catch {}
  }

  managedPowerShellChildren.clear();

  for (const child of managedNativeCommandChildren) {
    try {
      child.kill();
    } catch {}
  }

  managedNativeCommandChildren.clear();
}

function sendWindowsMediaKey(command) {
  return sendWindowsMediaKeyCommand(command, {
    mediaSessionMonitor: windowsMediaSessionMonitor,
    runPowerShell
  });
}

function broadcastSpotifyLiteState(nextState) {
  const window = widgetWindows.get('spotify-lite');

  if (window && !window.isDestroyed()) {
    window.webContents.send('spotify-lite:state-updated', nextState);
  }

  if (dockerWindow && !dockerWindow.isDestroyed() && state.widgets['spotify-lite']?.docked) {
    dockerWindow.webContents.send('spotify-lite:state-updated', nextState);
  }
}

function initializeSpotifyLiteService() {
  windowsMediaSessionMonitor = new WindowsMediaSessionMonitor();
  spotifyLiteService = new SpotifyLiteService({
    tokenFilePath: path.join(app.getPath('userData'), 'spotify-lite-auth.json'),
    playbackCacheFilePath: path.join(app.getPath('userData'), 'spotify-lite-playback-cache.json'),
    clientId: localSettings.spotifyClientId,
    clientSecret: localSettings.spotifyClientSecret,
    openExternal: (url) => shell.openExternal(url),
    sendMediaKey: sendWindowsMediaKey,
    mediaSessionMonitor: windowsMediaSessionMonitor,
    onStateChanged: broadcastSpotifyLiteState
  });
}

function escapePowerShellSingleQuotedString(value) {
  return String(value || '').replaceAll("'", "''");
}

function normalizeDeviceBatteryPercent(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const percent = Number(value);

  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return null;
  }

  return Math.round(percent);
}

function normalizeDeviceRecord(device) {
  const id = String(device.id || '').trim();
  const name = String(device.name || '').trim();

  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    className: String(device.className || 'Device'),
    status: String(device.status || ''),
    connected: Boolean(device.connected),
    containerId: String(device.containerId || ''),
    bluetoothAddress: String(device.bluetoothAddress || '').toUpperCase(),
    batteryPercent: normalizeDeviceBatteryPercent(device.batteryPercent)
  };
}

function getBluetoothAddressFromDevice(device) {
  const source = [
    device?.id,
    device?.bluetoothAddress,
    device?.containerId,
    device?.name
  ].filter(Boolean).join(' ');
  const match = /(?:DEV_|_)([0-9A-F]{12})(?:\\|&|_|$)/i.exec(source)
    || /\b([0-9A-F]{12})\b/i.exec(source);

  return match ? match[1].toUpperCase() : null;
}

function cleanDeviceName(name) {
  return String(name || '')
    .replace(/\s+Avrcp Transport$/i, '')
    .replace(/\s+Hands-Free(?:\s+AG)?$/i, '')
    .replace(/^Speakers \((.+)\)$/i, '$1')
    .trim();
}

function isNoisyDeviceRecord(device) {
  const name = String(device.name || '');
  const className = String(device.className || '');
  const id = String(device.id || '');

  return (
    /^Bluetooth$/i.test(name)
    || /Avrcp Transport|Hands-Free|Generic Attribute Profile|Generic Access Profile|Device Information Service|Bluetooth LE Generic Attribute Service/i.test(name)
    || /AMD|Realtek|NVIDIA|USB 3\.|GPIO|I2C Controller|High Definition Audio|Streaming|Virtual Audio|Nahimic|Microsoft|Storage Spaces|VHD|interrupt controller/i.test(name)
    || /MEDIA|AudioEndpoint|System|USB|SCSIAdapter|Battery|Net|Ports|SoftwareDevice/i.test(className)
    || /^(ACPI|PCI|ROOT|SWD)\\/i.test(id)
    || /ELAN0300/i.test(id)
  );
}

function getDevicePriority(device) {
  const id = String(device.id || '');
  const className = String(device.className || '');

  if (/^BTHLE\\DEV_/i.test(id)) {
    return 100;
  }

  if (/^BTHENUM\\DEV_/i.test(id)) {
    return 90;
  }

  if (/Bluetooth/i.test(className)) {
    return 80;
  }

  if (/Mouse|Keyboard|XnaComposite/i.test(className)) {
    return 60;
  }

  if (/HIDClass/i.test(className)) {
    return 40;
  }

  return 10;
}

function dedupePhysicalDevices(devices) {
  const grouped = new Map();

  for (const device of devices) {
    if (isNoisyDeviceRecord(device)) {
      continue;
    }

    const bluetoothAddress = getBluetoothAddressFromDevice(device);
    const normalizedDevice = {
      ...device,
      name: cleanDeviceName(device.name),
      bluetoothAddress: bluetoothAddress || ''
    };
    const key = bluetoothAddress
      ? `bt:${bluetoothAddress}`
      : normalizedDevice.containerId
        ? `container:${normalizedDevice.containerId}`
        : `name:${normalizedDevice.name.toLowerCase()}`;
    const current = grouped.get(key);

    if (!current || getDevicePriority(normalizedDevice) > getDevicePriority(current)) {
      grouped.set(key, normalizedDevice);
    }
  }

  return [...grouped.values()]
    .sort((a, b) => a.name.localeCompare(b.name, ['ru', 'en'], {
      numeric: true,
      sensitivity: 'base'
    }));
}

async function getKnownDevices(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();

  if (!force && knownDevicesCache && now - knownDevicesCache.readAt < knownDevicesCacheMs) {
    return knownDevicesCache.data;
  }

  if (!force && knownDevicesReadInFlight) {
    return knownDevicesReadInFlight;
  }

  if (process.platform !== 'win32') {
    return {
      devices: [],
      error: 'Device monitoring is available on Windows only.'
    };
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$targets = Get-PnpDevice -PresentOnly | Where-Object {
  $_.FriendlyName -and (
    $_.InstanceId -match '^(BTHLE|BTHENUM)\\\\DEV_' -or
    $_.Class -match 'Mouse|Keyboard|XnaComposite' -or
    $_.FriendlyName -match 'gamepad|xbox|dualSense|joy-con|aerox|cidoo|jbl|huawei|freebuds'
  ) -and
  $_.FriendlyName -notmatch '^Bluetooth$|Avrcp Transport|Hands-Free|Generic Attribute Profile|Generic Access Profile|Device Information Service|Bluetooth LE Generic Attribute Service|AMD|Realtek|NVIDIA|USB 3\\.|GPIO|I2C Controller|High Definition Audio|Streaming|Virtual Audio|Nahimic|Microsoft|Storage Spaces|VHD|interrupt controller' -and
  $_.Class -notmatch 'MEDIA|AudioEndpoint|System|USB|SCSIAdapter|Battery|Net|Ports|SoftwareDevice' -and
  $_.InstanceId -notmatch '^(ACPI|PCI|ROOT|SWD)\\\\|ELAN0300'
}

$items = foreach ($device in $targets) {
  $container = $null
  $address = $null

  if ($device.InstanceId -match '^(BTHLE|BTHENUM)\\\\DEV_') {
    $container = Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName 'DEVPKEY_Device_ContainerId' -ErrorAction SilentlyContinue
    $address = Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName 'DEVPKEY_Bluetooth_DeviceAddress' -ErrorAction SilentlyContinue
  }

  [pscustomobject]@{
    id = $device.InstanceId
    name = $device.FriendlyName
    className = $device.Class
    status = $device.Status
    connected = ($device.Status -eq 'OK')
    containerId = if ($container -and $container.Data) { [string]$container.Data } else { '' }
    bluetoothAddress = if ($address -and $address.Data) { [string]$address.Data } else { '' }
    batteryPercent = $null
  }
}

$items |
  Sort-Object name, className, id -Unique |
  ConvertTo-Json -Depth 4
`;

  knownDevicesReadInFlight = (async () => {
    try {
      const output = (await runPowerShell(script)).trim();
      const parsed = output ? JSON.parse(output) : [];
      const rawDevices = Array.isArray(parsed) ? parsed : [parsed];
      const normalizedDevices = rawDevices
        .map(normalizeDeviceRecord)
        .filter(Boolean);
      const devices = dedupePhysicalDevices(normalizedDevices);

      const result = {
        devices,
        error: null
      };

      knownDevicesCache = {
        readAt: Date.now(),
        data: result
      };

      return result;
    } catch (error) {
      return {
        devices: [],
        error: error.message
      };
    } finally {
      knownDevicesReadInFlight = null;
    }
  })();

  return knownDevicesReadInFlight;
}

async function getBleBatteryPercent(device) {
  const bluetoothAddress = getBluetoothAddressFromDevice(
    typeof device === 'string' ? { id: device } : device
  );

  if (!bluetoothAddress) {
    return null;
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Devices.Bluetooth.BluetoothLEDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceService,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristic,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WinRtBufferReader {
  [ComImport]
  [Guid("905a0fef-bc53-11df-8c49-001e4fc686da")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IBufferByteAccess {
    IntPtr Buffer();
  }

  public static byte ReadFirstByte(object buffer) {
    var access = (IBufferByteAccess)buffer;
    return Marshal.ReadByte(access.Buffer());
  }
}
"@

function Await-WinRt($operation, $resultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  $task.Result
}

$bluetoothAddress = [Convert]::ToUInt64('${bluetoothAddress}', 16)
$device = Await-WinRt ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($bluetoothAddress)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])

if (-not $device) {
  return
}

$serviceGuid = [Guid]'0000180f-0000-1000-8000-00805f9b34fb'
$services = Await-WinRt ($device.GetGattServicesForUuidAsync($serviceGuid)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])

if ($services.Status -ne 'Success') {
  return
}

foreach ($service in $services.Services) {
  $characteristicGuid = [Guid]'00002a19-0000-1000-8000-00805f9b34fb'
  $characteristics = Await-WinRt ($service.GetCharacteristicsForUuidAsync($characteristicGuid)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])

  if ($characteristics.Status -ne 'Success') {
    continue
  }

  foreach ($characteristic in $characteristics.Characteristics) {
    $read = Await-WinRt ($characteristic.ReadValueAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattReadResult])

    if ($read.Status -eq 'Success') {
      [WinRtBufferReader]::ReadFirstByte($read.Value)
      return
    }
  }
}
`;

  try {
    const output = (await runPowerShell(script, 15000)).trim();
    return normalizeDeviceBatteryPercent(output);
  } catch {
    return null;
  }
}

function getSavedDeviceList() {
  const widgetState = state.widgets.devices || {};
  return Array.isArray(widgetState.observedDevices) ? widgetState.observedDevices : [];
}

function saveDeviceList(devices) {
  const widgetState = state.widgets.devices || {};
  const currentDevices = Array.isArray(widgetState.observedDevices)
    ? widgetState.observedDevices
    : [];
  if (JSON.stringify(currentDevices) === JSON.stringify(devices)) {
    return false;
  }

  widgetState.observedDevices = devices;
  state.widgets.devices = widgetState;
  saveWidgetState();
  return true;
}

function getStoredDeviceMonitorData() {
  return {
    availableDevices: [],
    observedDevices: getSavedDeviceList(),
    error: null,
    refreshedAt: Date.now()
  };
}

function mergeSavedDeviceWithCurrent(savedDevice, knownDevices) {
  const savedBluetoothAddress = getBluetoothAddressFromDevice(savedDevice);
  const currentDevice = knownDevices.find((device) => device.id === savedDevice.id)
    || knownDevices.find((device) => savedBluetoothAddress && getBluetoothAddressFromDevice(device) === savedBluetoothAddress)
    || knownDevices.find((device) => device.containerId && device.containerId === savedDevice.containerId);

  if (!currentDevice) {
    return {
      ...savedDevice,
      connected: false,
      batteryPercent: null
    };
  }

  return {
    ...savedDevice,
    ...currentDevice
  };
}

function devicesReferToSameHardware(first, second) {
  if (first?.id && second?.id && first.id === second.id) {
    return true;
  }

  const firstAddress = getBluetoothAddressFromDevice(first);
  const secondAddress = getBluetoothAddressFromDevice(second);
  if (firstAddress && secondAddress && firstAddress === secondAddress) {
    return true;
  }

  return Boolean(
    first?.containerId
    && second?.containerId
    && first.containerId === second.containerId
  );
}

async function refreshObservedDevices(savedDevices) {
  let pnpSnapshot = new Map();

  if (process.platform === 'win32') {
    try {
      pnpSnapshot = await readPnpDeviceSnapshot(savedDevices, {
        runPowerShell,
        normalizeBatteryPercent: normalizeDeviceBatteryPercent
      });
    } catch (error) {
      console.error('Failed to refresh observed Windows devices:', error);
    }
  }

  const refreshedDevices = savedDevices.map((device) => {
    const pnpDevice = pnpSnapshot.get(device.id);
    return {
      ...device,
      connected: Boolean(pnpDevice?.connected),
      batteryPercent: pnpDevice?.connected ? pnpDevice.batteryPercent : null
    };
  });
  const bleCandidates = refreshedDevices
    .map((device, index) => ({ device, index }))
    .filter(({ device }) => (
      device.connected
      && device.batteryPercent === null
      && getBluetoothAddressFromDevice(device)
    ));

  await mapWithConcurrency(bleCandidates, 2, async ({ device, index }) => {
    refreshedDevices[index] = {
      ...device,
      batteryPercent: await getBleBatteryPercent(device)
    };
  });

  return refreshedDevices;
}

async function getDeviceMonitorData(_options = {}) {
  const now = Date.now();
  if (
    !_options.force
    && deviceMonitorCache
    && now - deviceMonitorCache.refreshedAt < deviceMonitorCacheMs
  ) {
    return deviceMonitorCache;
  }

  if (deviceMonitorReadInFlight) {
    return deviceMonitorReadInFlight;
  }

  const savedDevices = getSavedDeviceList();

  if (!savedDevices.length) {
    deviceMonitorCache = {
      availableDevices: [],
      observedDevices: [],
      error: null,
      refreshedAt: Date.now()
    };
    return deviceMonitorCache;
  }

  deviceMonitorReadInFlight = (async () => {
    try {
      const refreshedDevices = await refreshObservedDevices(savedDevices);
      const latestSavedDevices = getSavedDeviceList();
      const observedDevices = latestSavedDevices.map((latestDevice) => {
        const refreshedDevice = refreshedDevices.find((device) => (
          devicesReferToSameHardware(device, latestDevice)
        ));

        return refreshedDevice
          ? {
              ...latestDevice,
              connected: refreshedDevice.connected,
              batteryPercent: refreshedDevice.batteryPercent
            }
          : latestDevice;
      });

      saveDeviceList(observedDevices);

      const result = {
        availableDevices: [],
        observedDevices,
        error: null,
        refreshedAt: Date.now()
      };
      deviceMonitorCache = result;
      return result;
    } finally {
      deviceMonitorReadInFlight = null;
    }
  })();

  return deviceMonitorReadInFlight;
}

async function getDevicePickerData() {
  const known = await getKnownDevices();

  return {
    availableDevices: known.devices,
    observedDevices: getSavedDeviceList(),
    error: known.error,
    refreshedAt: Date.now()
  };
}

async function addObservedDevice(deviceId) {
  const known = await getKnownDevices();
  const selectedDevice = known.devices.find((device) => device.id === deviceId);

  if (!selectedDevice) {
    throw new Error('Device was not found.');
  }

  const savedDevices = getSavedDeviceList();
  const exists = savedDevices.some((device) => (
    device.id === selectedDevice.id
    || (device.containerId && selectedDevice.containerId && device.containerId === selectedDevice.containerId)
  ));

  if (!exists) {
    saveDeviceList([...savedDevices, selectedDevice]);
    deviceMonitorCache = null;
  }

  const data = getStoredDeviceMonitorData();
  const window = widgetWindows.get('devices');

  if (window && !window.isDestroyed()) {
    window.webContents.send('devices:observed-updated', data);
  }

  if (dockerWindow && !dockerWindow.isDestroyed() && state.widgets.devices?.docked) {
    dockerWindow.webContents.send('devices:observed-updated', data);
  }

  return data;
}

async function removeObservedDevice(deviceId) {
  const savedDevices = getSavedDeviceList();
  const targetDevice = savedDevices.find((device) => device.id === deviceId);
  const targetBluetoothAddress = getBluetoothAddressFromDevice(targetDevice || { id: deviceId });
  const nextDevices = savedDevices.filter((device) => (
    device.id !== deviceId
    && (!targetDevice?.containerId || device.containerId !== targetDevice.containerId)
    && (!targetBluetoothAddress || getBluetoothAddressFromDevice(device) !== targetBluetoothAddress)
  ));

  saveDeviceList(nextDevices);
  deviceMonitorCache = null;
  const data = getStoredDeviceMonitorData();
  const window = widgetWindows.get('devices');

  if (window && !window.isDestroyed()) {
    window.webContents.send('devices:observed-updated', data);
  }

  if (dockerWindow && !dockerWindow.isDestroyed() && state.widgets.devices?.docked) {
    dockerWindow.webContents.send('devices:observed-updated', data);
  }

  return data;
}

async function sendTodoTreeUpdate(tree = null) {
  const window = widgetWindows.get('todo');
  const hasTodoWindow = window && !window.isDestroyed();
  const hasDockerTodo = dockerWindow
    && !dockerWindow.isDestroyed()
    && state.widgets.todo?.docked;

  if (!hasTodoWindow && !hasDockerTodo) {
    return;
  }

  const nextTree = tree || await getTodoTree();
  if (hasTodoWindow) {
    window.webContents.send('todo:tree-updated', nextTree);
  }

  if (hasDockerTodo) {
    dockerWindow.webContents.send('todo:tree-updated', nextTree);
  }
}

function scheduleTodoTreeUpdate() {
  if (!shouldWatchTodoFiles()) {
    return;
  }

  clearTimeout(todoRefreshTimer);
  todoRefreshTimer = setTimeout(() => {
    todoRefreshTimer = null;
    void sendTodoTreeUpdate();
  }, 1500);
}

function createTodoWatcher() {
  const watcher = chokidar.watch(todoRootPath, {
    ignoreInitial: true,
    persistent: true,
    atomic: true,
    ignorePermissionErrors: true,
    ignored: (watchPath, stats) => {
      if (!stats?.isFile()) {
        return false;
      }

      const fileName = path.basename(watchPath);
      return path.extname(fileName).toLowerCase() !== '.md' || ignoredTodoFiles.has(fileName);
    }
  });

  watcher
    .on('add', scheduleTodoTreeUpdate)
    .on('change', scheduleTodoTreeUpdate)
    .on('unlink', scheduleTodoTreeUpdate)
    .on('addDir', scheduleTodoTreeUpdate)
    .on('unlinkDir', scheduleTodoTreeUpdate)
    .on('error', (error) => {
      console.error('Todo watcher error:', error);
    });

  return watcher;
}

function shouldWatchTodoFiles() {
  if (isQuitting) {
    return false;
  }

  const todoWindow = widgetWindows.get('todo');
  const hasTodoWindow = todoWindow && !todoWindow.isDestroyed();
  const hasDockerTodo = dockerWindow
    && !dockerWindow.isDestroyed()
    && state.widgets.todo?.docked;

  return Boolean(hasTodoWindow || hasDockerTodo);
}

function syncTodoWatcher() {
  todoWatcherController.setActive(shouldWatchTodoFiles());
}

function closeTodoWatcher() {
  clearTimeout(todoRefreshTimer);
  todoRefreshTimer = null;
  todoWatcherController.setActive(false);
  return todoWatcherController.closePromise;
}

function syncAutostartState() {
  const settings = app.getLoginItemSettings({ path: process.execPath });
  state.autostart = settings.openAtLogin;
  saveWidgetState();
}

function createTrayIcon() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
  );

  return icon.resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Widgets');

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open widgets',
      click: () => createMenuWindow()
    },
    { type: 'separator' },
    {
      label: 'Open state file',
      click: () => shell.showItemInFolder(stateFilePath)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ]));

  tray.on('click', () => createMenuWindow());
}

function setupIpcBridge() {
  ipcMain.handle('app:get-menu-data', () => ({
    widgets: WIDGETS.map((widget) => ({
      ...widget,
      state: state.widgets[widget.id] || {}
    })),
    autostart: state.autostart,
    appearance: state.appearance,
    stateFilePath
  }));

  ipcMain.handle('widget:get-data', (_event, widgetId) => {
    const widget = getWidgetDefinition(widgetId);

    if (!widget) {
      throw new Error(`Unknown widget: ${widgetId}`);
    }

    return {
      widget,
      state: state.widgets[widgetId] || {},
      appearance: state.appearance
    };
  });

  ipcMain.handle('widget:open', (_event, widgetId) => {
    if (state.widgets[widgetId]?.docked) {
      restoreDockedWidget(widgetId);
    } else {
      createWidgetWindow(widgetId);
    }
    return state.widgets[widgetId];
  });

  ipcMain.handle('widget:close', (event, widgetId) => {
    const window = widgetWindows.get(widgetId);

    if (window && !window.isDestroyed()) {
      window.close();
    } else if (state.widgets[widgetId]?.docked) {
      removeDockedWidget(widgetId);
    } else if (state.widgets[widgetId]) {
      state.widgets[widgetId].open = false;
      saveWidgetState();
    }

    return state.widgets[widgetId];
  });

  ipcMain.handle('widget:dock', (_event, widgetId) => dockWidget(widgetId));

  ipcMain.handle('docker:get-data', () => getDockerData());

  ipcMain.handle('docker:restore-widget', (_event, widgetId) => restoreDockedWidget(widgetId));

  ipcMain.handle('docker:set-layout', (_event, positions) => setDockerLayout(positions));

  ipcMain.handle('widget:set-always-on-top', (_event, widgetId, value) => {
    setAlwaysOnTop(widgetId, value);
    return state.widgets[widgetId];
  });

  ipcMain.handle('app:set-autostart', (_event, enabled) => {
    setAutostart(enabled);
    return state.autostart;
  });

  ipcMain.handle('app:set-appearance', (_event, appearance) => setAppearance(appearance));

  ipcMain.handle('notes:get-content', () => getNotesContent());

  ipcMain.handle('notes:save-content', (_event, content) => saveNotesContent(content));

  ipcMain.handle('notes:confirm-close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== widgetWindows.get('notes') || window.isDestroyed()) {
      return false;
    }

    notesWindowsReadyToClose.add(window);
    window.close();
    return true;
  });

  ipcMain.handle('spotify-lite:get-state', () => spotifyLiteService.getState());

  ipcMain.handle('spotify-lite:connect', () => spotifyLiteService.connect());

  ipcMain.handle('spotify-lite:refresh', () => spotifyLiteService.refreshNow({ forceQueue: true }));

  ipcMain.handle('spotify-lite:media-command', (_event, command) => spotifyLiteService.mediaCommand(command));

  ipcMain.handle('spotify-lite:seek', (_event, positionMs) => spotifyLiteService.seek(positionMs));

  ipcMain.handle('spotify-lite:set-expanded', (_event, expanded) => setSpotifyLiteExpanded(expanded));

  ipcMain.handle('spotify-lite:set-desktop-mode', (_event, enabled) => setSpotifyLiteDesktopMode(enabled));

  ipcMain.handle('spotify-lite:set-footer-visible', (_event, visible) => setSpotifyLiteFooterVisible(visible));

  ipcMain.handle('spotify-lite:open-dashboard', () => shell.openExternal('https://developer.spotify.com/dashboard'));

  ipcMain.handle('devices:get-data', () => getDeviceMonitorData());

  ipcMain.handle('devices:refresh-data', () => getDeviceMonitorData({ force: true }));

  ipcMain.handle('devices:get-picker-data', () => getDevicePickerData());

  ipcMain.handle('devices:add-observed', (_event, deviceId) => addObservedDevice(deviceId));

  ipcMain.handle('devices:remove-observed', (_event, deviceId) => removeObservedDevice(deviceId));

  ipcMain.handle('devices:open-picker', () => openDevicesPickerWindow());

  ipcMain.handle('devices:close-picker', (event) => hideDevicesPickerWindow(event.sender));

  ipcMain.on('devices:picker-content-ready', (event, requestId) => {
    showDevicesPickerWindow(requestId, event.sender);
  });

  ipcMain.handle('devices:open-menu', (_event, deviceId) => openDevicesContextMenu(deviceId));

  ipcMain.handle('devices:close-menu', (event) => hideDevicesContextMenu(event.sender));

  ipcMain.on('devices:menu-content-ready', (event, requestId) => {
    showDevicesContextMenu(requestId, event.sender);
  });

  ipcMain.handle('clock:set-desktop-mode', (_event, enabled) => setClockDesktopMode(enabled));

  ipcMain.handle('clock:open-menu', () => openClockContextMenu());

  ipcMain.handle('desktop-widget:open-menu', (_event, widgetId) => openClockContextMenu(widgetId));

  ipcMain.handle('clock:close-menu', (event) => hideClockContextMenu(event.sender));

  ipcMain.handle('clock:edit', (event) => editClockFromContextMenu(event.sender));

  ipcMain.on('clock:menu-content-ready', (event, requestId) => {
    showClockContextMenu(requestId, event.sender);
  });

  ipcMain.handle('todo:get-tree', () => getTodoTree());

  ipcMain.handle('todo:configure', (event) => configureTodoSettings(BrowserWindow.fromWebContents(event.sender)));

  ipcMain.handle('todo:open-task-editor', (_event, taskId) => openTodoTaskEditor(taskId));

  ipcMain.handle('todo:open-task-menu', (_event, taskId) => openTodoTaskContextMenu(taskId));

  ipcMain.handle('todo:open-group-menu', (_event, groupId) => openTodoGroupContextMenu(groupId));

  ipcMain.handle('todo:get-task-details', (_event, taskId) => getTodoTaskDetails(taskId));

  ipcMain.handle('todo:save-task-details', (_event, taskId, details) => saveTodoTaskDetails(taskId, details));

  ipcMain.handle('todo:delete-task', (_event, taskId) => deleteTodoTask(taskId));

  ipcMain.handle('todo:open-task', (_event, taskId) => openTodoTask(taskId));

  ipcMain.handle('todo:create-task', (_event, groupId, title, details) => createTodoTask(groupId, title, details));

  ipcMain.handle('todo:close-task-editor', (event) => hideTodoEditorWindow(event.sender));

  ipcMain.on('todo:editor-content-ready', (event, requestId) => {
    showTodoEditorWindow(requestId, event.sender);
  });

  ipcMain.handle('todo:close-task-menu', (event) => hideTodoContextMenu(event.sender));

  ipcMain.on('todo:menu-content-ready', (event, requestId) => {
    showTodoContextMenu(requestId, event.sender);
  });

  ipcMain.handle('todo:open-create-window', (_event, groupId) => openTodoCreateWindow(groupId));

  ipcMain.handle('todo:close-create-window', (event) => hideTodoCreateWindow(event.sender));

  ipcMain.on('todo:create-content-ready', (event, requestId) => {
    showTodoCreateWindow(requestId, event.sender);
  });

  ipcMain.handle('todo:move-task', (_event, taskId, targetGroupId) => moveTodoTask(taskId, targetGroupId));

  ipcMain.handle('window:renderer-ready', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    if (window) {
      markRendererReady(window);

      if (window === dockerWindow) {
        broadcastDockerState();
      }

      if (window === todoEditorWindow) {
        resolveTodoEditorReady?.(true);
        resolveTodoEditorReady = null;
      }

      if (window === todoContextMenuWindow) {
        resolveTodoContextMenuReady?.(true);
        resolveTodoContextMenuReady = null;
      }

      if (window === devicesContextMenuWindow) {
        resolveDevicesContextMenuReady?.(true);
        resolveDevicesContextMenuReady = null;
      }

      if (window === devicesPickerWindow) {
        resolveDevicesPickerReady?.(true);
        resolveDevicesPickerReady = null;
      }

      if (window === clockContextMenuWindow) {
        resolveClockContextMenuReady?.(true);
        resolveClockContextMenuReady = null;
      }

      if (window === todoCreateWindow) {
        resolveTodoCreateReady?.(true);
        resolveTodoCreateReady = null;
      }
    }
  });

  ipcMain.handle('window:get-position', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.getPosition() || [0, 0];
  });

  ipcMain.on('window:set-position', (event, x, y) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    if (window && Number.isFinite(x) && Number.isFinite(y)) {
      window.setPosition(Math.round(x), Math.round(y));
    }
  });

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle('window:close-current', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {});

  app.whenReady().then(() => {
    ensureStateFile();
    initializeSpotifyLiteService();
    syncAutostartState();
    setupIpcBridge();
    screen.on('display-removed', (_event, display) => {
      setImmediate(() => restoreManagedWindowsToVisibleDisplays(display?.workArea));
    });
    screen.on('display-metrics-changed', () => {
      setImmediate(() => restoreManagedWindowsToVisibleDisplays());
    });
    createTray();
    restoreMenuState();
    restoreWidgetState();
    restoreDockerState();
    syncTodoWatcher();
  });

  app.on('activate', () => {});

  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    isQuitting = true;
    clearTimeout(visualEffectsRefreshTimer);
    visualEffectsRefreshTimer = null;
    dwmWindowEffects.dispose();
    stopAllManagedCommandProcesses();
    stopAllDesktopWidgetMouseHooks();
    closeTodoWatcher();
    spotifyLiteService?.dispose();

    if (menuWindow && !menuWindow.isDestroyed()) {
      persistMenuWindowBounds();
      setMenuOpenState(true);
    }

    if (dockerWindow && !dockerWindow.isDestroyed()) {
      persistDockerWindowBounds();
    }

    for (const [widgetId, window] of widgetWindows) {
      persistWindowBounds(widgetId, window);
      setWidgetOpenState(widgetId, true);
    }
  });
}


