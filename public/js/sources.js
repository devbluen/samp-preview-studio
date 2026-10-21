// Where models come from: the player's GTA SA folder (IMG archives + modloader mods) and assets.open.mp.
// Works in three hosts: a static page (GitHub Pages), the local Node server and the desktop app.
import { HandleFolder, FileListFolder, HttpFolder } from './game/folder.js';
import { LocalGame } from './game/localgame.js';

const OPENMP_DFF = 'https://assets.open.mp/models/models/';
const OPENMP_TEX = 'https://assets.open.mp/models/exports/';
const VARIANT_KEY = 'td-preview-variant';

const SAMP_NEEDS_GAME = 'SA-MP objects (18631+) load from your game: choose your GTA SA folder (top right).';
export const isSampObject = (id) => id >= 18631 && id <= 19999;
export const kindOf = (id) => (id >= 0 && id <= 311 ? 'skin' : id >= 400 && id <= 611 ? 'vehicle' : 'object');

class Sources extends EventTarget {
    constructor() {
        super();
        this.env = { proxy: false, desktop: false, gamePath: '' };
        this.game = null; // LocalGame
        this.folderName = this.folderPath = '';
        this.pendingHandle = null; // stored handle waiting for permission (needs a click)
        this.base = new Map(); // id -> [id, model, name, kind]
        this.catalog = [];
        this.generation = 0; // bumped whenever the loaded files can change (texture cache key)
        try { this.variant = localStorage.getItem(VARIANT_KEY) === 'default' ? 'default' : 'modified'; } catch { this.variant = 'modified'; }
    }

    async init() {
        try {
            const res = await fetch('api/env');
            if (res.ok && res.headers.get('content-type')?.includes('json')) Object.assign(this.env, await res.json());
        } catch { /* static host */ }
        const res = await fetch('data/catalog.json');
        for (const item of await res.json()) this.base.set(item[0], item);

        // A remembered folder that can't be read any more must not break the page
        try {
            if (this.env.gamePath) await this.useFolder(new HttpFolder(this.env.gamePath), false);
            else {
                const handle = await idb('get').catch(() => null);
                if (handle) {
                    if ((await handle.queryPermission?.({ mode: 'read' })) === 'granted') await this.useFolder(new HandleFolder(handle), false);
                    else this.pendingHandle = handle;
                }
            }
        } catch (e) {
            this.folderError = e.message;
        }
        if (!this.game) this.rebuild();
    }

    // ---------------- game folder ----------------

    /**
     * Asks for the folder. `compat` uses <input webkitdirectory> (any browser, not remembered).
     * Returns false when the picker was closed without a folder.
     */
    async pick({ compat = false } = {}) {
        if (this.env.desktop) {
            const path = await window.desktop.pickGameFolder();
            if (path) await this.useFolder(new HttpFolder(path));
            return;
        }
        if (!compat && 'showDirectoryPicker' in window) {
            let handle;
            try {
                handle = await window.showDirectoryPicker({ id: 'gta-sa', mode: 'read' });
            } catch (e) {
                // Also what Chrome does after refusing a system folder such as Program Files
                if (e.name === 'AbortError') return false;
                throw e;
            }
            await this.useFolder(new HandleFolder(handle));
            await idb('put', handle).catch(() => {});
            return;
        }
        const files = await pickDirectoryFiles();
        if (files?.length) await this.useFolder(new FileListFolder(files));
    }

    /** Re-grants access to the folder chosen in a previous visit (must run inside a click). */
    async reconnect() {
        const handle = this.pendingHandle;
        if (!handle || (await handle.requestPermission({ mode: 'read' })) !== 'granted') return;
        this.pendingHandle = null;
        await this.useFolder(new HandleFolder(handle));
    }

    async forget() {
        if (this.env.desktop) await window.desktop.forgetGameFolder();
        await idb('delete').catch(() => {});
        this.game = null;
        this.folderName = this.folderPath = '';
        this.pendingHandle = null;
        this.changed();
    }

    async useFolder(folder, notify = true) {
        const game = new LocalGame(folder);
        await game.load();
        this.game = game;
        this.folderName = folder.name;
        this.folderPath = folder.path || folder.name;
        this.folderError = '';
        this.pendingHandle = null;
        if (notify) this.changed();
        else this.rebuild();
    }

    setVariant(v) {
        this.variant = v === 'default' ? 'default' : 'modified';
        try { localStorage.setItem(VARIANT_KEY, this.variant); } catch { /* */ }
        this.changed();
    }

    changed() {
        this.rebuild();
        this.dispatchEvent(new Event('change'));
    }

    /** Catalog rows: [id, model, name, kind ('s'|'v'|'o'), hasMod] */
    rebuild() {
        this.generation++;
        const rows = new Map();
        for (const [id, item] of this.base) rows.set(id, item.slice(0, 4));
        for (const [id, m] of this.game?.models ?? []) if (!rows.has(id)) rows.set(id, [id, m.model, '', m.kind[0]]);
        if (this.game?.mods.size) {
            for (const [id, row] of rows) {
                const m = this.game.models.get(id);
                if (m && (this.game.hasMod(m.model + '.dff') || this.game.hasMod(m.txd + '.txd'))) row[4] = true;
            }
        }
        this.catalog = [...rows.values()].sort((a, b) => a[0] - b[0]);
    }

    get modCount() {
        return this.game?.mods.size ?? 0;
    }

    // ---------------- model resolution ----------------

    /**
     * Returns { info, dff: ArrayBuffer, textures: (names) -> Promise<Map> }.
     * Modified: modloader > game IMG > open.mp. Default: open.mp > game IMG (modloader ignored).
     * info.textures is 'rgba' (decoded TXD data) or 'url' (PNG files from open.mp).
     */
    async resolve(id) {
        const row = this.base.get(id);
        const lm = this.game?.models.get(id);
        const kind = lm?.kind ?? (row ? { s: 'skin', v: 'vehicle', o: 'object' }[row[3]] : kindOf(id));
        const name = row?.[2] || row?.[1] || lm?.model;
        const useMods = this.variant === 'modified';
        const tryLocal = async () => {
            const where = lm && this.game.locate(lm.model + '.dff', useMods);
            if (!where) return null;
            const dff = await this.game.readFile(lm.model + '.dff', useMods);
            const chain = this.game.txdChain(lm, kind);
            const txdMod = useMods && chain.some((t) => this.game.hasMod(t + '.txd'));
            return {
                info: { id, kind, model: lm.model, name, source: 'local', origin: where.origin, modified: where.modified || txdMod, textures: 'rgba' },
                dff: dff.buffer.slice(dff.byteOffset, dff.byteOffset + dff.byteLength),
                textures: async () => {
                    const map = new Map();
                    for (const txd of chain) for (const [n, t] of await this.game.readTxd(txd, useMods)) if (!map.has(n)) map.set(n, t);
                    return map;
                },
            };
        };
        const tryOpenmp = async () => {
            if (!row) return null;
            // SA-MP's own objects (hats, glasses, masks...) only exist in SAMP.img, not on open.mp
            if (isSampObject(id) && !this.game) throw new Error(SAMP_NEEDS_GAME);
            const model = row[1].toLowerCase();
            const url = this.env.proxy ? `api/openmp/dff/${encodeURIComponent(model)}` : `${OPENMP_DFF}${encodeURIComponent(model)}.dff`;
            let res;
            try {
                res = await fetch(url);
            } catch {
                return null; // offline
            }
            if (!res.ok) throw new Error(`Model "${model}" is not available on open.mp (${res.status}).`);
            return {
                info: { id, kind, model, name, source: 'openmp', origin: 'open.mp', modified: false, textures: 'url' },
                dff: await res.arrayBuffer(),
                textures: async (names) => new Map(names.map((n) => [n, this.env.proxy ? `api/openmp/tex/${encodeURIComponent(n)}.png` : `${OPENMP_TEX}${encodeURIComponent(n)}.png`])),
            };
        };

        const order = useMods ? [tryLocal, tryOpenmp] : [tryOpenmp, tryLocal];
        let error = null;
        for (const attempt of order) {
            try {
                const found = await attempt();
                if (found) return found;
            } catch (e) {
                error ??= e;
            }
        }
        if (error) throw error;
        if (!this.game) throw new Error('Could not reach assets.open.mp. Choose your GTA San Andreas folder (top right) to load models from your game.');
        throw new Error(`Model ${id} was not found in the game folder or on open.mp.`);
    }
}

export const sources = new Sources();

// ---------------- helpers ----------------

function pickDirectoryFiles() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.onchange = () => resolve([...input.files]);
        input.oncancel = () => resolve(null);
        input.click();
    });
}

// The FileSystemDirectoryHandle survives reloads only through IndexedDB
function idb(op, value) {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('samp-preview', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
            const store = tx.objectStore('kv');
            const req = op === 'get' ? store.get('gameFolder') : op === 'put' ? store.put(value, 'gameFolder') : store.delete('gameFolder');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        };
    });
}
