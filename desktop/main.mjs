// Desktop app: runs the local server (open.mp proxy + game folder access) and shows the page in its own window.
// The page is served under app://studio/ so its origin (and localStorage) stays the same between runs.
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
    try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}

function writeConfig(config) {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 4));
}

// A GTA SA folder has data/gta.dat or models/gta3.img (names compared case-insensitively)
function looksLikeGame(dir) {
    const has = (base, name) => {
        try { return fs.readdirSync(base).find((f) => f.toLowerCase() === name); } catch { return null; }
    };
    for (const [sub, file] of [['data', 'gta.dat'], ['models', 'gta3.img']]) {
        const found = has(dir, sub);
        if (found && has(path.join(dir, found), file)) return true;
    }
    return false;
}

protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
});

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const config = readConfig();
    if (config.gtaPath && !fs.existsSync(config.gtaPath)) config.gtaPath = '';
    const server = await startServer({ port: 0, cacheDir: path.join(app.getPath('userData'), 'cache'), config, desktop: true });

    protocol.handle('app', (req) => {
        const url = new URL(req.url);
        return net.fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`);
    });

    ipcMain.handle('pick-game-folder', async (e) => {
        const owner = BrowserWindow.fromWebContents(e.sender);
        for (;;) {
            const res = await dialog.showOpenDialog(owner, {
                title: 'Choose your GTA San Andreas folder',
                defaultPath: config.gtaPath || undefined,
                properties: ['openDirectory'],
            });
            const dir = res.filePaths[0];
            if (res.canceled || !dir) return null;
            if (looksLikeGame(dir)) {
                config.gtaPath = dir;
                writeConfig(config);
                server.setGamePath(dir);
                return dir;
            }
            const { response } = await dialog.showMessageBox(owner, {
                type: 'warning',
                message: 'This is not a GTA San Andreas folder',
                detail: `"${dir}" has no data/gta.dat or models/gta3.img. Pick the folder that contains gta_sa.exe.`,
                buttons: ['Choose another folder', 'Cancel'],
            });
            if (response === 1) return null;
        }
    });
    ipcMain.handle('forget-game-folder', () => {
        config.gtaPath = '';
        writeConfig(config);
        server.setGamePath('');
    });

    win = new BrowserWindow({
        width: 1600,
        height: 950,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0f1115',
        title: 'SA-MP Preview Studio',
        webPreferences: { preload: PRELOAD },
    });
    // Links open in the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.loadURL('app://studio/');
});

app.on('window-all-closed', () => app.quit());
