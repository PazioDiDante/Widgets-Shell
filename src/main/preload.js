const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetsApi', {
  getMenuData: () => ipcRenderer.invoke('app:get-menu-data'),
  setAutostart: (enabled) => ipcRenderer.invoke('app:set-autostart', enabled),
  setAppearance: (appearance) => ipcRenderer.invoke('app:set-appearance', appearance),
  onAppearanceUpdated: (callback) => {
    const listener = (_event, appearance) => callback(appearance);
    ipcRenderer.on('app:appearance-updated', listener);
    return () => ipcRenderer.removeListener('app:appearance-updated', listener);
  },
  getNotesContent: () => ipcRenderer.invoke('notes:get-content'),
  saveNotesContent: (content) => ipcRenderer.invoke('notes:save-content', content),
  confirmNotesClose: () => ipcRenderer.invoke('notes:confirm-close'),
  onNotesCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('notes:close-requested', listener);
    return () => ipcRenderer.removeListener('notes:close-requested', listener);
  },
  getWidgetData: (widgetId) => ipcRenderer.invoke('widget:get-data', widgetId),
  openWidget: (widgetId) => ipcRenderer.invoke('widget:open', widgetId),
  closeWidget: (widgetId) => ipcRenderer.invoke('widget:close', widgetId),
  dockWidget: (widgetId) => ipcRenderer.invoke('widget:dock', widgetId),
  getDockerData: () => ipcRenderer.invoke('docker:get-data'),
  restoreDockedWidget: (widgetId) => ipcRenderer.invoke('docker:restore-widget', widgetId),
  setDockerLayout: (positions) => ipcRenderer.invoke('docker:set-layout', positions),
  onDockerStateUpdated: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('docker:state-updated', listener);
    return () => ipcRenderer.removeListener('docker:state-updated', listener);
  },
  setAlwaysOnTop: (widgetId, value) => ipcRenderer.invoke('widget:set-always-on-top', widgetId, value),
  getSpotifyLiteState: () => ipcRenderer.invoke('spotify-lite:get-state'),
  connectSpotifyLite: () => ipcRenderer.invoke('spotify-lite:connect'),
  refreshSpotifyLite: () => ipcRenderer.invoke('spotify-lite:refresh'),
  sendSpotifyLiteMediaCommand: (command) => ipcRenderer.invoke('spotify-lite:media-command', command),
  seekSpotifyLite: (positionMs) => ipcRenderer.invoke('spotify-lite:seek', positionMs),
  setSpotifyLiteExpanded: (expanded) => ipcRenderer.invoke('spotify-lite:set-expanded', expanded),
  setSpotifyLiteDesktopMode: (enabled) => ipcRenderer.invoke('spotify-lite:set-desktop-mode', enabled),
  setSpotifyLiteFooterVisible: (visible) => ipcRenderer.invoke('spotify-lite:set-footer-visible', visible),
  openSpotifyDashboard: () => ipcRenderer.invoke('spotify-lite:open-dashboard'),
  onSpotifyLiteStateUpdated: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('spotify-lite:state-updated', listener);
    return () => ipcRenderer.removeListener('spotify-lite:state-updated', listener);
  },
  getDevicesData: () => ipcRenderer.invoke('devices:get-data'),
  refreshDevicesData: () => ipcRenderer.invoke('devices:refresh-data'),
  getDevicePickerData: () => ipcRenderer.invoke('devices:get-picker-data'),
  addObservedDevice: (deviceId) => ipcRenderer.invoke('devices:add-observed', deviceId),
  removeObservedDevice: (deviceId) => ipcRenderer.invoke('devices:remove-observed', deviceId),
  openDevicePicker: () => ipcRenderer.invoke('devices:open-picker'),
  closeDevicePicker: () => ipcRenderer.invoke('devices:close-picker'),
  devicePickerContentReady: (requestId) => ipcRenderer.send('devices:picker-content-ready', requestId),
  onDevicePickerLoad: (callback) => {
    const listener = (_event, target) => callback(target);
    ipcRenderer.on('devices:picker-load', listener);
    return () => ipcRenderer.removeListener('devices:picker-load', listener);
  },
  openDeviceMenu: (deviceId) => ipcRenderer.invoke('devices:open-menu', deviceId),
  closeDeviceMenu: () => ipcRenderer.invoke('devices:close-menu'),
  deviceMenuContentReady: (requestId) => ipcRenderer.send('devices:menu-content-ready', requestId),
  onDeviceMenuLoad: (callback) => {
    const listener = (_event, target) => callback(target);
    ipcRenderer.on('devices:menu-load-target', listener);
    return () => ipcRenderer.removeListener('devices:menu-load-target', listener);
  },
  onObservedDevicesUpdated: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('devices:observed-updated', listener);
    return () => ipcRenderer.removeListener('devices:observed-updated', listener);
  },
  setClockDesktopMode: (enabled) => ipcRenderer.invoke('clock:set-desktop-mode', enabled),
  openClockMenu: () => ipcRenderer.invoke('clock:open-menu'),
  openDesktopWidgetMenu: (widgetId) => ipcRenderer.invoke('desktop-widget:open-menu', widgetId),
  closeClockMenu: () => ipcRenderer.invoke('clock:close-menu'),
  editClock: () => ipcRenderer.invoke('clock:edit'),
  clockMenuContentReady: (requestId) => ipcRenderer.send('clock:menu-content-ready', requestId),
  onClockMenuLoad: (callback) => {
    const listener = (_event, target) => callback(target);
    ipcRenderer.on('clock:menu-load', listener);
    return () => ipcRenderer.removeListener('clock:menu-load', listener);
  },
  getTodoTree: () => ipcRenderer.invoke('todo:get-tree'),
  configureTodo: () => ipcRenderer.invoke('todo:configure'),
  openTodoTaskEditor: (taskId) => ipcRenderer.invoke('todo:open-task-editor', taskId),
  openTodoTaskMenu: (taskId) => ipcRenderer.invoke('todo:open-task-menu', taskId),
  openTodoGroupMenu: (groupId) => ipcRenderer.invoke('todo:open-group-menu', groupId),
  getTodoTaskDetails: (taskId) => ipcRenderer.invoke('todo:get-task-details', taskId),
  saveTodoTaskDetails: (taskId, details) => ipcRenderer.invoke('todo:save-task-details', taskId, details),
  deleteTodoTask: (taskId) => ipcRenderer.invoke('todo:delete-task', taskId),
  openTodoTask: (taskId) => ipcRenderer.invoke('todo:open-task', taskId),
  closeTodoTaskEditor: () => ipcRenderer.invoke('todo:close-task-editor'),
  todoEditorContentReady: (requestId) => ipcRenderer.send('todo:editor-content-ready', requestId),
  onTodoEditorLoadTask: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on('todo:editor-load-task', listener);
    return () => ipcRenderer.removeListener('todo:editor-load-task', listener);
  },
  onTodoEditorCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('todo:editor-close-requested', listener);
    return () => ipcRenderer.removeListener('todo:editor-close-requested', listener);
  },
  onTodoEditorTaskMoved: (callback) => {
    const listener = (_event, taskId) => callback(taskId);
    ipcRenderer.on('todo:editor-task-moved', listener);
    return () => ipcRenderer.removeListener('todo:editor-task-moved', listener);
  },
  onTodoEditorTaskDeleted: (callback) => {
    const listener = (_event, taskId) => callback(taskId);
    ipcRenderer.on('todo:editor-task-deleted', listener);
    return () => ipcRenderer.removeListener('todo:editor-task-deleted', listener);
  },
  closeTodoTaskMenu: () => ipcRenderer.invoke('todo:close-task-menu'),
  todoTaskMenuContentReady: (requestId) => ipcRenderer.send('todo:menu-content-ready', requestId),
  onTodoTaskMenuLoad: (callback) => {
    const listener = (_event, target) => callback(target);
    ipcRenderer.on('todo:menu-load-target', listener);
    return () => ipcRenderer.removeListener('todo:menu-load-target', listener);
  },
  openTodoCreateWindow: (groupId) => ipcRenderer.invoke('todo:open-create-window', groupId),
  createTodoTask: (groupId, title, details) => ipcRenderer.invoke('todo:create-task', groupId, title, details),
  closeTodoCreateWindow: () => ipcRenderer.invoke('todo:close-create-window'),
  todoCreateContentReady: (requestId) => ipcRenderer.send('todo:create-content-ready', requestId),
  onTodoCreateLoadGroup: (callback) => {
    const listener = (_event, group) => callback(group);
    ipcRenderer.on('todo:create-load-group', listener);
    return () => ipcRenderer.removeListener('todo:create-load-group', listener);
  },
  onTodoCreateCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('todo:create-close-requested', listener);
    return () => ipcRenderer.removeListener('todo:create-close-requested', listener);
  },
  moveTodoTask: (taskId, targetGroupId) => ipcRenderer.invoke('todo:move-task', taskId, targetGroupId),
  onTodoTreeUpdated: (callback) => {
    const listener = (_event, tree) => callback(tree);
    ipcRenderer.on('todo:tree-updated', listener);
    return () => ipcRenderer.removeListener('todo:tree-updated', listener);
  },
  rendererReady: () => ipcRenderer.invoke('window:renderer-ready'),
  getCurrentWindowPosition: () => ipcRenderer.invoke('window:get-position'),
  setCurrentWindowPosition: (x, y) => ipcRenderer.send('window:set-position', x, y),
  minimizeCurrentWindow: () => ipcRenderer.invoke('window:minimize'),
  closeCurrentWindow: () => ipcRenderer.invoke('window:close-current')
});
