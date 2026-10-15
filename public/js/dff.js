// RenderWare DFF parser (GTA SA), ported from AmyrAhmady/openmp-models (src/domain/dffParser.ts).
// Works in both the browser and Node (ES module, no dependencies).

const CHUNK_STRUCT = 0x1;
const CHUNK_STRING = 0x2;
const CHUNK_EXTENSION = 0x3;
const CHUNK_TEXTURE = 0x6;
const CHUNK_MATERIAL = 0x7;
const CHUNK_MATLIST = 0x8;
const CHUNK_FRAMELIST = 0xe;
const CHUNK_GEOMETRY = 0xf;
const CHUNK_CLUMP = 0x10;
const CHUNK_ATOMIC = 0x14;
const CHUNK_GEOMETRYLIST = 0x1a;
const CHUNK_SKIN = 0x116;
const CHUNK_HANIM = 0x11e;
const CHUNK_BINMESH = 0x50e;
const CHUNK_NATIVEDATA = 0x510;
const CHUNK_FRAME = 0x253f2fe;

const FLAGS_TRISTRIP = 0x1;
const FLAGS_TEXTURED = 0x4;
const FLAGS_PRELIT = 0x8;
const FLAGS_NORMALS = 0x10;
const FLAGS_TEXTURED2 = 0x80;

class Reader {
    constructor(buffer) {
        this.view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
        this.bytes = new Uint8Array(this.view.buffer, this.view.byteOffset, this.view.byteLength);
        this.offset = 0;
    }
    ensure(n) {
        if (n < 0 || this.offset + n > this.view.byteLength) throw new Error('Fim inesperado do DFF');
    }
    u8() { this.ensure(1); return this.view.getUint8(this.offset++); }
    u16() { this.ensure(2); const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    i32() { this.ensure(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
    u32() { this.ensure(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    f32() { this.ensure(4); const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
    skip(n) { this.ensure(n); this.offset += n; }
    str(n) {
        this.ensure(n);
        let end = 0;
        while (end < n && this.bytes[this.offset + end] !== 0) end++;
        const s = new TextDecoder('latin1').decode(this.bytes.subarray(this.offset, this.offset + end));
        this.offset += n;
        return s;
    }
    chunk() {
        const type = this.u32();
        const length = this.u32();
        const version = this.u32();
        const payload = this.offset;
        const end = payload + length;
        if (end > this.view.byteLength) throw new Error(`Chunk DFF inválido 0x${type.toString(16)}`);
        return { type, length, version, payload, end };
    }
    finish(c) { this.offset = c.end; }
}

// Column-major 4x4 matrix (THREE.Matrix4.fromArray layout)
function readMatrix(r) {
    const rot = Array.from({ length: 9 }, () => r.f32());
    const pos = [r.f32(), r.f32(), r.f32()];
    return [rot[0], rot[1], rot[2], 0, rot[3], rot[4], rot[5], 0, rot[6], rot[7], rot[8], 0, pos[0], pos[1], pos[2], 1];
}

function readFrameList(r) {
    const list = r.chunk();
    if (list.type !== CHUNK_FRAMELIST) throw new Error('DFF sem frame list');
    const st = r.chunk();
    const count = r.u32();
    const frames = [];
    for (let i = 0; i < count; i++) {
        const matrix = readMatrix(r);
        const parent = r.i32();
        r.skip(4);
        frames.push({ name: '', parent, matrix, boneId: null, hanimNodes: null });
    }
    r.finish(st);
    for (const frame of frames) {
        const ext = r.chunk();
        if (ext.type !== CHUNK_EXTENSION) throw new Error('Frame sem extensão');
        while (r.offset < ext.end) {
            const c = r.chunk();
            if (c.type === CHUNK_FRAME) frame.name = r.str(c.length);
            else if (c.type === CHUNK_HANIM && c.length >= 12) {
                r.skip(4);
                frame.boneId = r.i32();
                const n = r.u32();
                if (n > 0) {
                    r.skip(8);
                    frame.hanimNodes = [];
                    for (let k = 0; k < n; k++) {
                        frame.hanimNodes.push(r.i32());
                        r.skip(8);
                    }
                }
            }
            r.finish(c);
        }
        r.finish(ext);
    }
    r.finish(list);
    return frames;
}

function readTextureName(r) {
    const tex = r.chunk();
    if (tex.type !== CHUNK_TEXTURE) throw new Error('Material sem textura');
    const st = r.chunk(); r.finish(st);
    const nameChunk = r.chunk();
    const name = nameChunk.type === CHUNK_STRING ? r.str(nameChunk.length) : '';
    r.finish(nameChunk);
    const mask = r.chunk(); r.finish(mask);
    r.finish(tex);
    return name;
}

function readMaterials(r) {
    const ml = r.chunk();
    if (ml.type !== CHUNK_MATLIST) throw new Error('Geometria sem material list');
    const st = r.chunk();
    const count = r.u32();
    const instanceOf = Array.from({ length: count }, () => r.i32());
    r.finish(st);
    const materials = [];
    for (let i = 0; i < count; i++) {
        if (instanceOf[i] >= 0 && materials[instanceOf[i]]) {
            materials.push(materials[instanceOf[i]]);
            continue;
        }
        const mat = r.chunk();
        if (mat.type !== CHUNK_MATERIAL) throw new Error('Material inválido');
        const mst = r.chunk();
        r.skip(4);
        const color = [r.u8(), r.u8(), r.u8(), r.u8()];
        r.skip(4);
        const hasTexture = r.i32() !== 0;
        r.finish(mst);
        const texture = hasTexture ? readTextureName(r) : '';
        r.finish(mat);
        materials.push({ color, texture });
    }
    r.finish(ml);
    return materials;
}

function readBinMesh(r, chunk, native) {
    const faceType = r.u32();
    const splitCount = r.u32();
    r.skip(4);
    const hasIndices = chunk.length > 12 + splitCount * 8;
    const splits = [];
    for (let s = 0; s < splitCount; s++) {
        const count = r.u32();
        const materialIndex = r.u32();
        const indices = [];
        if (hasIndices) for (let i = 0; i < count; i++) indices.push(native ? r.u16() : r.u32());
        splits.push({ materialIndex, indices });
    }
    return { strip: faceType === 1, splits };
}

function readNativeValue(view, off, type, norm) {
    let v;
    switch (type) {
        case 0: v = view.getFloat32(off, true); break;
        case 1: v = view.getInt8(off); break;
        case 2: v = view.getUint8(off); break;
        case 3: v = view.getInt16(off, true); break;
        case 4: v = view.getUint16(off, true); break;
        default: throw new Error('Atributo nativo não suportado');
    }
    if (!norm) return v;
    return [v, v / 128, v / 255, v / 32768, v / 65536][type];
}

function readNativeOgl(r, chunk, geo) {
    const n = r.u32();
    const attrs = [];
    for (let i = 0; i < n; i++) attrs.push({ attribute: r.u32(), type: r.u32(), norm: r.u32(), count: r.u32(), stride: r.u32(), offset: r.u32() });
    const start = r.offset;
    const read = (a, v) => {
        const size = a.type === 0 ? 4 : a.type < 3 ? 1 : 2;
        const base = start + a.offset + v * a.stride;
        const out = [];
        for (let c = 0; c < a.count; c++) out.push(readNativeValue(r.view, base + c * size, a.type, a.norm));
        return out;
    };
    for (const a of attrs) {
        if (a.attribute === 0) {
            geo.positions = new Float32Array(geo.vertexCount * 3);
            for (let v = 0; v < geo.vertexCount; v++) geo.positions.set(read(a, v).slice(0, 3), v * 3);
        } else if (a.attribute === 1) {
            geo.uvs = new Float32Array(geo.vertexCount * 2);
            for (let v = 0; v < geo.vertexCount; v++) {
                const t = read(a, v);
                geo.uvs[v * 2] = t[0] / 512;
                geo.uvs[v * 2 + 1] = t[1] / 512;
            }
        }
    }
    r.offset = chunk.end;
}

function readSkin(r, vertexCount) {
    const numBones = r.u8();
    const numUsed = r.u8();
    r.skip(2);
    r.skip(numUsed);
    const indices = new Uint8Array(r.bytes.slice(r.offset, r.offset + vertexCount * 4));
    r.skip(vertexCount * 4);
    const weights = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount * 4; i++) weights[i] = r.f32();
    const inverse = [];
    for (let b = 0; b < numBones; b++) {
        if (numUsed === 0) r.skip(4); // old format: 0xDEADDEAD before each matrix
        const m = Array.from({ length: 16 }, () => r.f32());
        m[3] = m[7] = m[11] = 0;
        m[15] = 1;
        inverse.push(m);
    }
    return { numBones, indices, weights, inverse };
}

function readGeometry(r) {
    const gc = r.chunk();
    if (gc.type !== CHUNK_GEOMETRY) throw new Error('Geometria inválida');
    const st = r.chunk();
    const flags = r.u16();
    let numUvs = r.u8();
    const native = r.u8() !== 0;
    const triCount = r.u32();
    const vertexCount = r.u32();
    r.skip(4);
    if (flags & FLAGS_TEXTURED) numUvs = Math.max(numUvs, 1);
    if (st.version < 0x34000) r.skip(12);
    const geo = { vertexCount, skin: null, positions: null, uvs: null, colors: null, materials: [], strip: !!(flags & FLAGS_TRISTRIP), splits: [] };
    if (!native) {
        if (flags & FLAGS_PRELIT) {
            geo.colors = new Uint8Array(r.bytes.slice(r.offset, r.offset + vertexCount * 4));
            r.skip(vertexCount * 4);
        }
        if (flags & (FLAGS_TEXTURED | FLAGS_TEXTURED2)) {
            for (let layer = 0; layer < numUvs; layer++) {
                if (layer === 0) {
                    geo.uvs = new Float32Array(vertexCount * 2);
                    for (let i = 0; i < vertexCount * 2; i++) geo.uvs[i] = r.f32();
                } else r.skip(vertexCount * 8);
            }
        }
        r.skip(triCount * 8);
    }
    r.skip(24); // bounding sphere + hasPosition + hasNormals
    if (!native) {
        geo.positions = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount * 3; i++) geo.positions[i] = r.f32();
        if (flags & FLAGS_NORMALS) r.skip(vertexCount * 12);
    }
    r.finish(st);
    geo.materials = readMaterials(r);
    const ext = r.chunk();
    while (r.offset < ext.end) {
        const c = r.chunk();
        if (c.type === CHUNK_BINMESH) {
            const bm = readBinMesh(r, c, native);
            geo.strip = bm.strip;
            geo.splits.push(...bm.splits);
        } else if (c.type === CHUNK_SKIN && !native && geo.positions) {
            geo.skin = readSkin(r, vertexCount);
        } else if (c.type === CHUNK_NATIVEDATA && native) {
            readNativeOgl(r, c, geo);
        }
        r.finish(c);
    }
    r.finish(ext);
    r.finish(gc);
    return geo;
}

/**
 * Returns { frames: [{name, parent, matrix}], atomics: [{frame, geometry}] }
 * geometry: { positions, uvs, colors, materials:[{color,texture}], strip, splits:[{materialIndex, indices}] }
 */
export function parseDff(buffer) {
    const r = new Reader(buffer);
    // Some DFFs have extra chunks (UV anim dict, etc.) before the clump
    let clump = r.chunk();
    while (clump.type !== CHUNK_CLUMP) {
        r.finish(clump);
        if (r.offset >= r.view.byteLength) throw new Error('DFF sem clump');
        clump = r.chunk();
    }
    const cst = r.chunk();
    const atomicCount = r.u32();
    r.finish(cst);
    const frames = readFrameList(r);
    const gl = r.chunk();
    if (gl.type !== CHUNK_GEOMETRYLIST) throw new Error('DFF sem geometry list');
    const gst = r.chunk();
    const geometryCount = r.u32();
    r.finish(gst);
    const geometries = [];
    for (let i = 0; i < geometryCount; i++) geometries.push(readGeometry(r));
    r.finish(gl);
    const atomics = [];
    for (let i = 0; i < atomicCount; i++) {
        const a = r.chunk();
        if (a.type !== CHUNK_ATOMIC) throw new Error('Atomic inválido');
        const ast = r.chunk();
        const frame = r.i32();
        const geometry = r.i32();
        r.finish(ast);
        r.finish(a);
        if (geometries[geometry]) atomics.push({ frame, geometry: geometries[geometry] });
    }
    // Map skin bone index -> frame index (via HAnim)
    const hier = frames.find((f) => f.hanimNodes);
    if (hier) {
        const frameById = new Map();
        frames.forEach((f, i) => { if (f.boneId !== null) frameById.set(f.boneId, i); });
        for (const a of atomics) {
            if (a.geometry.skin) a.geometry.skin.boneFrames = hier.hanimNodes.map((id) => frameById.get(id) ?? -1);
        }
    }
    return { frames, atomics };
}

/** Unique (lowercase) list of texture names used by the model */
export function textureNames(dff) {
    const set = new Set();
    for (const a of dff.atomics) for (const m of a.geometry.materials) if (m.texture) set.add(m.texture.toLowerCase());
    return [...set];
}
