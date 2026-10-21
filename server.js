// Local server for the page: static files, an assets.open.mp proxy with disk cache (models keep working
// offline once seen) and read-only access to a configured GTA SA folder.
// Used by `npm start` and by the desktop app (desktop/main.mjs).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DFF = 'https://assets.open.mp/models/models/';
const ASSETS_TEX = 'https://assets.open.mp/models/exports/';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/**
 * options: { port, host, cacheDir, config: { gtaPath }, desktop }
 * Returns { server, port, setGamePath(path) }.
 */
export function startServer({ port = 3000, host = '127.0.0.1', cacheDir = path.join(ROOT, 'cache'), config = {}, desktop = false } = {}) {
    const PUBLIC = path.join(ROOT, 'public');
    // The desktop app ships its three.js files in vendor/ (electron-builder drops "examples" folders from node_modules)
    const THREE = fs.existsSync(path.join(ROOT, 'vendor', 'three')) ? path.join(ROOT, 'vendor', 'three') : path.join(ROOT, 'node_modules', 'three');
    const state = { gtaPath: config.gtaPath || '' };

    // ---------- disk cache for remote assets ----------
    const inflight = new Map();
    async function cachedFetch(url, file) {
        const full = path.join(cacheDir, file);
        try {
            return await fsp.readFile(full);
        } catch { /* not cached yet */ }
        if (inflight.has(full)) return inflight.get(full);
        const p = (async () => {
            const res = await fetch(url);
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status} at ${url}`);
                err.status = res.status === 404 ? 404 : 502;
                throw err;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            await fsp.mkdir(path.dirname(full), { recursive: true });
            await fsp.writeFile(full, buf);
            return buf;
        })().finally(() => inflight.delete(full));
        inflight.set(full, p);
        return p;
    }

    // ---------- game folder (case-insensitive, never leaves gtaPath) ----------
    const dirCache = new Map();
    function resolveGame(rel) {
        if (!state.gtaPath) return null;
        const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
        if (parts.some((p) => p === '..' || p === '.')) return null;
        let cur = state.gtaPath;
        for (const part of parts) {
            const direct = path.join(cur, part);
            if (fs.existsSync(direct)) { cur = direct; continue; }
            if (!dirCache.has(cur)) {
                try { dirCache.set(cur, fs.readdirSync(cur)); } catch { return null; }
            }
            const found = dirCache.get(cur).find((f) => f.toLowerCase() === part.toLowerCase());
            if (!found) return null;
            cur = path.join(cur, found);
        }
        return cur;
    }

    function listGame(relDir) {
        const base = resolveGame(relDir);
        const out = [];
        const walk = (dir, prefix) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (e.name.startsWith('.') || out.length > 20000) continue;
                if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
                else if (e.isFile()) out.push(prefix + e.name);
            }
        };
        if (base) walk(base, relDir.replace(/\\/g, '/').replace(/\/?$/, '/'));
        return out;
    }

    async function readRange(file, offset, length) {
        const fh = await fsp.open(file, 'r');
        try {
            const size = (await fh.stat()).size;
            offset = Math.max(0, Math.min(offset, size));
            length = Math.max(0, Math.min(Number.isFinite(length) ? length : size - offset, size - offset));
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, offset);
            return buf;
        } finally {
            await fh.close();
        }
    }

    // ---------- HTTP ----------
    function send(res, status, body, type = 'application/json') {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    }

    const safeName = (s) => /^[\w.\-]+$/.test(s);

    async function serveStatic(res, base, rel) {
        const file = path.normalize(path.join(base, rel));
        if (!file.startsWith(base)) return send(res, 403, { error: 'forbidden' });
        try {
            const data = await fsp.readFile(file);
            send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
        } catch {
            send(res, 404, { error: 'not found' });
        }
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const p = decodeURIComponent(url.pathname);
        const q = (k) => url.searchParams.get(k) ?? '';
        try {
            if (p === '/api/env') return send(res, 200, { proxy: true, desktop, gamePath: state.gtaPath });

            let m = p.match(/^\/api\/openmp\/dff\/(.+)$/);
            if (m && safeName(m[1])) {
                const name = m[1].toLowerCase();
                return send(res, 200, await cachedFetch(`${ASSETS_DFF}${encodeURIComponent(name)}.dff`, `dff/${name}.dff`), 'application/octet-stream');
            }
            m = p.match(/^\/api\/openmp\/tex\/(.+)\.png$/);
            if (m && safeName(m[1])) {
                const name = m[1].toLowerCase();
                return send(res, 200, await cachedFetch(`${ASSETS_TEX}${encodeURIComponent(name)}.png`, `tex/${name}.png`), 'image/png');
            }

            if (p === '/api/game/stat' || p === '/api/game/read') {
                const file = resolveGame(q('path'));
                const st = file && (await fsp.stat(file).catch(() => null));
                if (!st?.isFile()) return send(res, 404, { error: 'not found' });
                if (p === '/api/game/stat') return send(res, 200, { size: st.size });
                const length = url.searchParams.has('length') ? Number(q('length')) : NaN;
                return send(res, 200, await readRange(file, Number(q('offset')) || 0, length), 'application/octet-stream');
            }
            if (p === '/api/game/list') return send(res, 200, listGame(q('dir')));

            if (p.startsWith('/vendor/three/')) return serveStatic(res, THREE, p.slice('/vendor/three/'.length));
            return serveStatic(res, PUBLIC, p === '/' ? 'index.html' : p);
        } catch (e) {
            send(res, e.status || 500, { error: e.message });
        }
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve({
                server,
                port: server.address().port,
                setGamePath(gtaPath) {
                    state.gtaPath = gtaPath || '';
                    dirCache.clear();
                },
            });
        });
    });
}

// ---------- `npm start` ----------
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const config = { port: 3000, gtaPath: '' };
    try {
        Object.assign(config, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
    } catch { /* no config.json: use defaults */ }
    if (process.env.PORT) config.port = Number(process.env.PORT);
    if (process.env.GTA_PATH) config.gtaPath = process.env.GTA_PATH;
    if (config.gtaPath && !fs.existsSync(config.gtaPath)) {
        console.error(`[local] gtaPath "${config.gtaPath}" does not exist; ignoring it`);
        config.gtaPath = '';
    }

    startServer({ port: config.port, host: process.env.HOST || '127.0.0.1', config })
        .then(({ port }) => {
            console.log(`SA-MP Preview Studio running at http://localhost:${port}`);
            console.log(config.gtaPath ? `Game folder: ${config.gtaPath}` : 'No gtaPath set: pick the game folder in the page, or set "gtaPath" in config.json');
        })
        .catch((e) => {
            if (e.code === 'EADDRINUSE') {
                console.error(`Port ${config.port} is already in use (is the app already running?). Use another one: PORT=3001 npm start, or "port" in config.json.`);
                process.exit(1);
            }
            throw e;
        });
}
