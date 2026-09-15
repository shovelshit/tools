const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("maoyanElectron", {
  getRuntimeInfo: () => ipcRenderer.invoke("runtime:get-info"),
  connectWorker: (input) => ipcRenderer.invoke("worker:connect", input),
  requestWorker: (path, options) => ipcRenderer.invoke("worker:request", { path, options }),
  loginMaoyan: (cinemaId) => ipcRenderer.invoke("maoyan:login", { cinemaId }),
  cancelMaoyanLogin: () => ipcRenderer.invoke("maoyan:cancel"),
  uploadSessionFile: () => ipcRenderer.invoke("maoyan:upload-file"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  openExternal: (url) => ipcRenderer.invoke("external:open", { url })
});
