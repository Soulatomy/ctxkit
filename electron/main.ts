import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from "electron";
import path from "node:path";
import fs from "node:fs";

/**
 * Electron shell for the fingerprint browser.
 *
 * The shell only renders the console UI. The actual fingerprint browsers are
 * separate processes spawned by the core (patchright Chromium / Camoufox),
 * exactly as in the CLI/web-console mode.
 */
const SMOKE = process.env.FB_ELECTRON_SMOKE === "1";

// Containers/CI have no user namespaces; the UI sandbox is irrelevant here.
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

let server: { url: string; close(): Promise<void> } | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;

const DEV_ROOT = path.resolve(__dirname, "..", ".."); // electron/dist -> project root

function resolveRoots(): { root: string; dataDir: string } {
  const root = app.isPackaged ? process.resourcesPath : DEV_ROOT;
  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, dataDir };
}

async function startCore(): Promise<{ url: string; close(): Promise<void> }> {
  const { root, dataDir } = resolveRoots();
  process.env.FB_ROOT = root;
  process.env.FB_DATA_DIR = dataDir;

  // Point patchright/Camoufox at bundled browsers when present.
  const bundledBrowsers = path.join(root, "browsers");
  if (fs.existsSync(bundledBrowsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;

  // Dynamic import so config.ts reads the env vars we just set.
  const { startServer } = await import("../src/server/index.js");
  return startServer({ port: 0, host: "127.0.0.1" });
}

function createWindow(url: string): void {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "Fingerprint Browser",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  void win.loadURL(url);

  if (SMOKE) {
    win.webContents.on("did-finish-load", () => {
      console.log("ELECTRON_SMOKE_UI_LOADED");
      setTimeout(() => app.quit(), 300);
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => {
      console.error(`ELECTRON_SMOKE_UI_FAILED ${code} ${desc}`);
      app.exit(2);
    });
  }

  // Open external audit links in the system browser, not inside the shell.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
  });
}

function createTray(url: string): void {
  try {
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip("Fingerprint Browser");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open console", click: () => (win ? win.focus() : createWindow(url)) },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  } catch {
    // Tray may be unavailable in some environments (e.g. headless CI).
  }
}

async function bootstrap(): Promise<void> {
  server = await startCore();
  console.log(`core listening: ${server.url}`);
  createWindow(server.url);
  if (!SMOKE) createTray(server.url);
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error("bootstrap failed:", err);
  app.exit(1);
});

app.on("activate", () => {
  if (!win && server) createWindow(server.url);
});

app.on("window-all-closed", () => {
  if (SMOKE) app.quit();
});

app.on("before-quit", () => {
  void server?.close();
});
