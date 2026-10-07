import { contextBridge } from "electron";

/**
 * Minimal, safe bridge for the console UI. The UI talks to the core over its
 * local HTTP API; this only exposes read-only shell info.
 */
contextBridge.exposeInMainWorld("fbShell", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
