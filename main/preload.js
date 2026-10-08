const { contextBridge, ipcRenderer } = require('electron');

const invoke = (method, ...args) => ipcRenderer.invoke(`launcher:${method}`, ...args);

contextBridge.exposeInMainWorld('launcher', Object.freeze({
  getState: () => invoke('get-state'),
  refreshVersions: () => invoke('refresh-versions'),
  getLoaderVersions: (loader, version) => invoke('get-loader-versions', loader, version),
  createInstance: (input) => invoke('create-instance', input),
  selectInstance: (id) => invoke('select-instance', id),
  updateInstance: (id, patch) => invoke('update-instance', id, patch),
  setInstanceCover: (id) => invoke('set-instance-cover', id),
  resetInstanceCover: (id) => invoke('reset-instance-cover', id),
  removeInstance: (id) => invoke('remove-instance', id),
  installInstance: (id) => invoke('install-instance', id),
  launchInstance: (id) => invoke('launch-instance', id),
  stopGame: () => invoke('stop-game'),
  cancelOperation: () => invoke('cancel-operation'),
  saveSettings: (patch) => invoke('save-settings', patch),
  previewAppearance: (value) => invoke('preview-appearance', value),
  startMicrosoftLogin: () => invoke('start-microsoft-login'),
  cancelMicrosoftLogin: () => invoke('cancel-microsoft-login'),
  saveMicrosoftClientId: (value) => invoke('save-microsoft-client-id', value),
  selectAccount: (mode) => invoke('select-account', mode),
  logoutMicrosoft: () => invoke('logout-microsoft'),
  refreshAccount: () => invoke('refresh-account'),
  openAccountLink: (target) => invoke('open-account-link', target),
  copyLoginCode: () => invoke('copy-login-code'),
  openCrashReport: () => invoke('open-crash-report'),
  scanJava: () => invoke('scan-java'),
  pickJava: () => invoke('pick-java'),
  openInstanceFolder: (id) => invoke('open-instance-folder', id),
  openDataFolder: () => invoke('open-data-folder'),
  getLogs: () => invoke('get-logs'),
  minimizeWindow: () => invoke('window-minimize'),
  maximizeWindow: () => invoke('window-maximize'),
  closeWindow: () => invoke('window-close'),
  onEvent: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('onEvent expects a callback');
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launcher:event', listener);
    return () => ipcRenderer.removeListener('launcher:event', listener);
  },
}));
