// 프린터 설정 창 전용 브릿지 — 로컬 파일(printer-settings.html)에서만 로드된다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("norderPS", {
  getState: () => ipcRenderer.invoke("printer:get-state"),
  save: (printer) => ipcRenderer.invoke("printer:save", printer),
  testPrint: (printer) => ipcRenderer.invoke("printer:test", printer),
  preview: (printer) => ipcRenderer.invoke("printer:preview", printer),
});
