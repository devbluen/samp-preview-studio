// Reads an installed GTA SA from a folder backend (see folder.js): gta.dat/default.dat -> IDEs and IMGs,
// .img (v2) archives, .txd files and loose .dff/.txd mods in modloader/.
const SECTOR = 2048;
const latin1 = new TextDecoder('latin1');

export class LocalGame {
    constructor(folder) {
        this.folder = folder;
        this.models = new Map(); // id -> { model, txd, kind }
        this.txdParent = new Map(); // txd -> parent txd
        this.imgEntries = new Map(); // name.ext (lowercase) -> { reader, offset, size, origin }
        this.mods = new Map(); // name.ext (lowercase) -> relative path of a loose file in modloader/
        this.txdCache = new Map();
    }

    async readText(rel) {
        const r = await this.folder.open(rel);
        return r ? latin1.decode(await r.read()) : null;
    }

    async load() {
        const ides = [];
        const imgs = ['models/gta3.img', 'models/gta_int.img'];
        for (const dat of ['data/default.dat', 'data/gta.dat']) {
            const text = await this.readText(dat);
            if (!text) continue;
            for (const raw of text.split(/\r?\n/)) {
                const line = raw.replace(/#.*/, '').trim();
                const m = line.match(/^(IDE|IMG)\s+(.+)$/i);
                if (m) (m[1].toUpperCase() === 'IDE' ? ides : imgs).push(m[2].trim());
            }
        }
        // SA-MP files (objects 18631+)
        ides.push('SAMP/SAMP.ide', 'SAMP/CUSTOM.ide');
        imgs.push('SAMP/SAMP.img', 'SAMP/CUSTOM.img');

        for (const ide of ides) {
            const text = await this.readText(ide);
            if (text) this.parseIde(text);
        }
        for (const img of [...new Set(imgs.map((i) => i.replace(/\\/g, '/').toLowerCase()))]) {
            const reader = await this.folder.open(img);
            if (reader) await this.parseImg(reader, img.split('/').pop());
        }
        if (!this.models.size) throw new Error('No IDE files found. Is this the GTA San Andreas folder?');

        // modloader: loose .dff/.txd files replace the ones inside the IMG archives
        for (const rel of await this.folder.list('modloader')) {
            const name = rel.split('/').pop().toLowerCase();
            if (/\.(dff|txd)$/.test(name) && !this.mods.has(name)) this.mods.set(name, rel);
        }
        const vehicleTxd = await this.folder.open('models/generic/vehicle.txd');
        if (vehicleTxd) this.genericVehicle = vehicleTxd;
    }

    parseIde(text) {
        let section = null;
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.replace(/#.*/, '').trim();
            if (!line) continue;
            const lower = line.toLowerCase();
            if (lower === 'end') { section = null; continue; }
            if (!section && /^[a-z]+$/.test(lower)) { section = lower; continue; }
            const f = line.split(',').map((s) => s.trim());
            if (section === 'txdp') {
                this.txdParent.set(f[0].toLowerCase(), f[1].toLowerCase());
                continue;
            }
            const kind = { objs: 'object', tobj: 'object', anim: 'object', weap: 'object', hier: 'object', peds: 'skin', cars: 'vehicle' }[section];
            const id = Number(f[0]);
            if (!kind || !Number.isInteger(id) || f.length < 3) continue;
            this.models.set(id, { model: f[1].toLowerCase(), txd: f[2].toLowerCase(), kind });
        }
    }

    async parseImg(reader, origin) {
        const head = new DataView((await reader.read(0, 8)).buffer);
        if (latin1.decode(new Uint8Array(head.buffer, 0, 4)) !== 'VER2') throw new Error(`${origin} is not an IMG v2 archive (GTA SA)`);
        const count = head.getUint32(4, true);
        const bytes = await reader.read(8, count * 32);
        const dir = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < count; i++) {
            const o = i * 32;
            const offset = dir.getUint32(o, true) * SECTOR;
            const size = (dir.getUint16(o + 4, true) || dir.getUint16(o + 6, true)) * SECTOR;
            let end = o + 8;
            while (end < o + 32 && bytes[end]) end++;
            const name = latin1.decode(bytes.subarray(o + 8, end)).toLowerCase();
            this.imgEntries.set(name, { reader, offset, size, origin });
        }
    }

    /** Where a file comes from: { origin, modified } or null. `useMods` = false ignores modloader. */
    locate(name, useMods = true) {
        name = name.toLowerCase();
        if (useMods && this.mods.has(name)) return { origin: this.mods.get(name), modified: true };
        const e = this.imgEntries.get(name);
        return e ? { origin: e.origin, modified: false } : null;
    }

    hasMod(name) {
        return this.mods.has(name.toLowerCase());
    }

    async readFile(name, useMods = true) {
        name = name.toLowerCase();
        if (useMods && this.mods.has(name)) {
            const r = await this.folder.open(this.mods.get(name));
            if (r) return r.read();
        }
        const e = this.imgEntries.get(name);
        return e ? e.reader.read(e.offset, e.size) : null;
    }

    txdChain(m, kind) {
        const chain = [];
        let t = m.txd;
        while (t && !chain.includes(t)) { chain.push(t); t = this.txdParent.get(t); }
        if (kind === 'vehicle') chain.push('vehicle'); // models/generic/vehicle.txd
        return chain;
    }

    /** Decoded textures of a TXD: Map<lowercase name, { width, height, rgba }> */
    async readTxd(name, useMods = true) {
        name = name.toLowerCase();
        const key = `${useMods}:${name}`;
        if (this.txdCache.has(key)) return this.txdCache.get(key);
        let buf = await this.readFile(name + '.txd', useMods);
        if (!buf && name === 'vehicle' && this.genericVehicle) buf = await this.genericVehicle.read();
        const textures = new Map();
        if (buf) for (const t of parseTxd(buf)) textures.set(t.name.toLowerCase(), t);
        if (this.txdCache.size > 64) this.txdCache.delete(this.txdCache.keys().next().value);
        this.txdCache.set(key, textures);
        return textures;
    }
}

// ---------------- TXD ----------------

function parseTxd(buf) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = [];
    let off = 0;
    const chunk = () => {
        const c = { type: view.getUint32(off, true), size: view.getUint32(off + 4, true), start: off + 12 };
        c.end = c.start + c.size;
        off = c.start;
        return c;
    };
    const dict = chunk();
    if (dict.type !== 0x16) throw new Error('Invalid TXD');
    const st = chunk();
    off = st.end;
    while (off + 12 <= Math.min(dict.end, buf.length)) {
        const tex = chunk();
        if (tex.type !== 0x15) { off = tex.end; continue; }
        try {
            const s = chunk();
            const t = decodeNative(buf, view, s.start);
            if (t) out.push(t);
        } catch { /* unsupported texture: skip */ }
        off = tex.end;
    }
    return out;
}

function decodeNative(buf, view, o) {
    const platform = view.getUint32(o, true);
    if (platform !== 8 && platform !== 9) return null;
    const cstr = (start, len) => {
        let e = start;
        while (e < start + len && buf[e]) e++;
        return latin1.decode(buf.subarray(start, e));
    };
    const name = cstr(o + 8, 32);
    const rasterFormat = view.getUint32(o + 72, true);
    const d3dFormat = view.getUint32(o + 76, true);
    const width = view.getUint16(o + 80, true);
    const height = view.getUint16(o + 82, true);
    const flags = buf[o + 87];
    let p = o + 88;
    let palette = null;
    if (rasterFormat & 0x2000) { palette = buf.subarray(p, p + 1024); p += 1024; }
    else if (rasterFormat & 0x4000) { palette = buf.subarray(p, p + 64); p += 64; }
    const size = view.getUint32(p, true);
    const data = buf.subarray(p + 4, p + 4 + size);

    let fmt;
    if (platform === 9) {
        fmt = { 0x31545844: 'DXT1', 0x33545844: 'DXT3', 0x35545844: 'DXT5', 21: '8888', 22: '888', 23: '565', 25: '1555', 26: '4444', 50: 'L8', 51: 'A8L8' }[d3dFormat];
        if (palette) fmt = 'PAL';
    } else {
        fmt = flags === 1 ? 'DXT1' : flags === 3 ? 'DXT3' : flags === 5 ? 'DXT5' : null;
        if (!fmt) fmt = palette ? 'PAL' : { 0x100: '1555', 0x200: '565', 0x300: '4444', 0x500: '8888', 0x600: '888' }[rasterFormat & 0xf00];
    }
    if (!fmt) return null;
    const rgba = new Uint8Array(width * height * 4);
    const n = width * height;
    switch (fmt) {
        case 'DXT1': case 'DXT3': case 'DXT5': decodeDxt(data, width, height, fmt, rgba); break;
        case '8888': case '888':
            for (let i = 0; i < n; i++) {
                rgba[i * 4] = data[i * 4 + 2]; rgba[i * 4 + 1] = data[i * 4 + 1]; rgba[i * 4 + 2] = data[i * 4];
                rgba[i * 4 + 3] = fmt === '8888' ? data[i * 4 + 3] : 255;
            }
            break;
        case '565': case '1555': case '4444':
            for (let i = 0; i < n; i++) {
                const v = data[i * 2] | (data[i * 2 + 1] << 8);
                let r, g, b, a = 255;
                if (fmt === '565') { r = (v >> 11) & 31; g = (v >> 5) & 63; b = v & 31; r = r * 255 / 31; g = g * 255 / 63; b = b * 255 / 31; }
                else if (fmt === '1555') { a = v & 0x8000 ? 255 : 0; r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31; }
                else { a = ((v >> 12) & 15) * 17; r = ((v >> 8) & 15) * 17; g = ((v >> 4) & 15) * 17; b = (v & 15) * 17; }
                rgba.set([r, g, b, a], i * 4);
            }
            break;
        case 'L8': case 'A8L8':
            for (let i = 0; i < n; i++) {
                const l = fmt === 'L8' ? data[i] : data[i * 2];
                rgba.set([l, l, l, fmt === 'L8' ? 255 : data[i * 2 + 1]], i * 4);
            }
            break;
        case 'PAL': {
            const pal4 = palette.length === 64;
            for (let i = 0; i < n; i++) {
                const idx = pal4 ? (data[i >> 1] >> ((i & 1) * 4)) & 15 : data[i];
                rgba.set(palette.subarray(idx * 4, idx * 4 + 4), i * 4);
            }
            break;
        }
    }
    return { name, width, height, rgba };
}

function decodeDxt(data, w, h, fmt, out) {
    const blockSize = fmt === 'DXT1' ? 8 : 16;
    const bw = Math.max(1, (w + 3) >> 2);
    const bh = Math.max(1, (h + 3) >> 2);
    const alpha = new Uint8Array(16);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            let o = (by * bw + bx) * blockSize;
            if (o + blockSize > data.length) return;
            alpha.fill(255);
            if (fmt === 'DXT3') {
                for (let i = 0; i < 16; i++) alpha[i] = ((data[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
                o += 8;
            } else if (fmt === 'DXT5') {
                const a0 = data[o], a1 = data[o + 1];
                const av = [a0, a1];
                if (a0 > a1) for (let i = 1; i < 7; i++) av.push(((7 - i) * a0 + i * a1) / 7 | 0);
                else { for (let i = 1; i < 5; i++) av.push(((5 - i) * a0 + i * a1) / 5 | 0); av.push(0, 255); }
                let bits = 0n;
                for (let i = 0; i < 6; i++) bits |= BigInt(data[o + 2 + i]) << BigInt(8 * i);
                for (let i = 0; i < 16; i++) alpha[i] = av[Number((bits >> BigInt(3 * i)) & 7n)];
                o += 8;
            }
            const c0 = data[o] | (data[o + 1] << 8);
            const c1 = data[o + 2] | (data[o + 3] << 8);
            const rgb = (v) => [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0];
            const p0 = rgb(c0), p1 = rgb(c1);
            const pal = [p0.concat(255), p1.concat(255)];
            if (c0 > c1 || fmt !== 'DXT1') {
                pal.push(p0.map((v, i) => (2 * v + p1[i]) / 3 | 0).concat(255), p0.map((v, i) => (v + 2 * p1[i]) / 3 | 0).concat(255));
            } else {
                pal.push(p0.map((v, i) => (v + p1[i]) >> 1).concat(255), [0, 0, 0, 0]);
            }
            const idx = data[o + 4] | (data[o + 5] << 8) | (data[o + 6] << 16) | (data[o + 7] << 24);
            for (let i = 0; i < 16; i++) {
                const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
                if (x >= w || y >= h) continue;
                const px = pal[(idx >>> (2 * i)) & 3];
                const d = (y * w + x) * 4;
                out[d] = px[0]; out[d + 1] = px[1]; out[d + 2] = px[2];
                out[d + 3] = fmt === 'DXT1' ? px[3] : alpha[i];
            }
        }
    }
}
