const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("valueSteward", {
  loadDashboardData: () => ipcRenderer.invoke("vs:load-dashboard-data"),
  runAction: (name) => ipcRenderer.invoke("vs:run-action", name),
  getSecretStatus: () => ipcRenderer.invoke("vs:get-secret-status"),
  setSecrets: (updates) => ipcRenderer.invoke("vs:set-secrets", updates),
  clearSecret: (key) => ipcRenderer.invoke("vs:clear-secret", key),
});
