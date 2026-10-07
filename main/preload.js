const { contextBridge, ipcRenderer } = require('electron');

const invoke = (method, ...args) => ipcRenderer.invoke(`launcher:${method}`, ...args);

contextBridge.exposeInMainWorld('launcher', Object.freeze({
  getState: () => invoke('get-state'),
  refreshVersions: () => invoke('refresh-versions'),
  installVersion: (id) => invoke('install-version', id),
  launchVersion: (id) => invoke('launch-version', id),
  cancelInstall: () => invoke('cancel-install'),
  saveSettings: (partial) => invoke('save-settings', partial),
  pickJava: () => invoke('pick-java'),
  pickGameDirectory: () => invoke('pick-game-directory'),
  openGameDirectory: () => invoke('open-game-directory'),
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
