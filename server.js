import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalGame } from './lib/localgame.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CACHE = path.join(ROOT, 'cache');
const ASSETS_DFF = 'https://assets.open.mp/models/models/';
const ASSETS_TEX = 'https://assets.open.mp/models/exports/';

// ---------- configuration ----------
const config = { port: 3000, gtaPath: '' };
try {
    Object.assign(config, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
} catch { /* no config.json: use defaults */ }
if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.GTA_PATH) config.gtaPath = process.env.GTA_PATH;

// ---------- catalog (open.mp) ----------
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const catalog = new Map(); // id -> { id, model, name, kind }
for (const s of readJson('skins.json')) catalog.set(s.id, { id: s.id, model: s.model, name: s.name, kind: 'skin' });
for (const v of readJson('vehicles.json')) catalog.set(v.id, { id: v.id, model: v.model, name: v.name, kind: 'vehicle' });
for (const o of readJson('objects.json')) catalog.set(o.id, { id: o.id, model: o.name, name: o.name, kind: 'object' });

// ---------- local game (optional) ----------
let local = null;
if (config.gtaPath) {
    try {
        local = new LocalGame(config.gtaPath);
        local.load();
        console.log(`[local] GTA SA carregado de ${config.gtaPath}: ${local.models.size} modelos em IDE, ${local.imgEntries.size} arquivos em IMG`);
        for (const [id, m] of local.models) {
            if (!catalog.has(id)) catalog.set(id, { id, model: m.model, name: m.model, kind: m.kind });
        }
    } catch (e) {
        console.error(`[local] Falha ao carregar o GTA em "${config.gtaPath}": ${e.message}`);
        local = null;
    }
}

function kindOf(id) {
    if (id >= 0 && id <= 311) return 'skin';
    if (id >= 400 && id <= 611) return 'vehicle';
    return 'object';
}

// ---------- disk cache for remote assets ----------
const inflight = new Map();
async function cachedFetch(url, file) {
    const full = path.join(CACHE, file);
    try {
        return await fsp.readFile(full);
    } catch { /* not cached yet */ }
    if (inflight.has(full)) return inflight.get(full);
    const p = (async () => {
        const res = await fetch(url);
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status} em ${url}`);
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

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const safeName = (s) => /^[\w.\-]+$/.test(s);

async function serveStatic(res, base, rel) {
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) return send(res, 403, { error: 'proibido' });
    try {
        const data = await fsp.readFile(file);
        send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
    } catch {
        send(res, 404, { error: 'não encontrado' });
    }
}

let catalogPayload = null;
function getCatalogPayload() {
    if (!catalogPayload) {
        const items = [...catalog.values()].sort((a, b) => a.id - b.id).map((c) => [c.id, c.model, c.name === c.model ? '' : c.name, c.kind[0]]);
        catalogPayload = JSON.stringify({ local: !!local, items });
    }
    return catalogPayload;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    try {
        if (p === '/api/catalog') return send(res, 200, getCatalogPayload());

        // Model info: where the DFF and textures come from
        let m = p.match(/^\/api\/model\/(-?\d+)$/);
        if (m) {
            const id = Number(m[1]);
            const prefer = url.searchParams.get('source'); // 'local' | 'openmp' | null
            const entry = catalog.get(id);
            const kind = entry?.kind ?? kindOf(id);
            const lm = local?.models.get(id);
            if (lm && prefer !== 'openmp' && local.hasFile(lm.model + '.dff')) {
                return send(res, 200, { id, kind: lm.kind, model: lm.model, name: entry?.name ?? lm.model, source: 'local', dff: `/api/local/dff/${lm.model}`, txds: local.txdChain(lm, kind) });
            }
            if (!entry) return send(res, 404, { error: `Modelo ${id} não existe no catálogo${local ? ' nem no jogo local' : ''}.` });
            return send(res, 200, { id, kind, model: entry.model, name: entry.name, source: 'openmp', dff: `/api/openmp/dff/${entry.model}` });
        }

        m = p.match(/^\/api\/openmp\/dff\/(.+)$/);
        if (m && safeName(m[1])) {
            const name = m[1].toLowerCase();
            return send(res, 200, await cachedFetch(`${ASSETS_DFF}${encodeURIComponent(name)}.dff`, `dff/${name}.dff`), 'application/octet-stream');
        }
        m = p.match(/^\/api\/openmp\/tex\/(.+)\.png$/);
        if (m && safeName(m[1])) {
            const name = m[1].toLowerCase();
            return send(res, 200, await cachedFetch(`${ASSETS_TEX}${encodeURIComponent(name)}.png`, `tex/${name}.png`), 'image/png');
        }
        m = p.match(/^\/api\/local\/dff\/(.+)$/);
        if (m && local && safeName(m[1])) {
            const buf = local.readFile(m[1] + '.dff');
            return buf ? send(res, 200, buf, 'application/octet-stream') : send(res, 404, { error: 'DFF não encontrado' });
        }
        m = p.match(/^\/api\/local\/txd\/(.+)$/);
        if (m && local && safeName(m[1])) {
            const tex = local.readTxd(m[1]);
            return tex ? send(res, 200, tex, 'application/octet-stream') : send(res, 404, { error: 'TXD não encontrado' });
        }

        if (p.startsWith('/vendor/three/')) return serveStatic(res, path.join(ROOT, 'node_modules', 'three'), p.slice('/vendor/three/'.length));
        return serveStatic(res, PUBLIC, p === '/' ? 'index.html' : p);
    } catch (e) {
        send(res, e.status || 500, { error: e.message });
    }
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`A porta ${config.port} já está em uso (o preview já está aberto?). Use outra: PORT=3001 npm start, ou "port" no config.json.`);
        process.exit(1);
    }
    throw e;
});

server.listen(config.port, () => {
    console.log(`Preview de TextDraw rodando em http://localhost:${config.port}`);
    if (!local) console.log('Fonte de modelos: assets.open.mp (configure "gtaPath" em config.json para usar o seu jogo)');
});
