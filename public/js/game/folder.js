// Read-only views of a GTA SA folder. Every backend exposes the same interface:
//   name                 display name
//   open(rel)            -> { size, read(offset, length) -> Uint8Array } | null (case-insensitive path)
//   list(relDir)         -> relative paths of every file below relDir (recursive)

const norm = (rel) => rel.replace(/\\/g, '/').split('/').filter(Boolean);

const blobReader = (blob) => ({
    size: blob.size,
    async read(offset = 0, length = blob.size - offset) {
        return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
});

/** File System Access API handle (Chrome/Edge). Can be stored in IndexedDB and reopened later. */
export class HandleFolder {
    constructor(handle) {
        this.handle = handle;
        this.name = handle.name;
        this.dirs = new Map(); // directory handle -> Map<lowercase name, handle>
    }

    async entries(dir) {
        if (!this.dirs.has(dir)) {
            const map = new Map();
            for await (const h of dir.values()) map.set(h.name.toLowerCase(), h);
            this.dirs.set(dir, map);
        }
        return this.dirs.get(dir);
    }

    async lookup(parts) {
        let cur = this.handle;
        for (const part of parts) {
            if (cur.kind !== 'directory') return null;
            cur = (await this.entries(cur)).get(part.toLowerCase());
            if (!cur) return null;
        }
        return cur;
    }

    async open(rel) {
        const h = await this.lookup(norm(rel));
        return h?.kind === 'file' ? blobReader(await h.getFile()) : null;
    }

    async list(relDir) {
        const out = [];
        const walk = async (dir, prefix) => {
            for (const [, h] of await this.entries(dir)) {
                if (h.name.startsWith('.')) continue; // modloader ignores dot folders
                if (h.kind === 'directory') await walk(h, `${prefix}${h.name}/`);
                else out.push(prefix + h.name);
            }
        };
        const base = await this.lookup(norm(relDir));
        if (base?.kind === 'directory') await walk(base, relDir.replace(/\/?$/, '/'));
        return out;
    }
}

/** <input webkitdirectory> file list: works in every browser, but has to be picked again on each visit. */
export class FileListFolder {
    constructor(files) {
        this.files = new Map();
        for (const f of files) {
            const parts = norm(f.webkitRelativePath || f.name);
            this.name ??= parts.length > 1 ? parts[0] : '';
            this.files.set(parts.slice(1).join('/').toLowerCase(), f);
        }
    }

    async open(rel) {
        const f = this.files.get(norm(rel).join('/').toLowerCase());
        return f ? blobReader(f) : null;
    }

    async list(relDir) {
        const prefix = norm(relDir).join('/').toLowerCase() + '/';
        const out = [];
        for (const [path, f] of this.files) {
            if (!path.startsWith(prefix) || path.split('/').some((p) => p.startsWith('.'))) continue;
            out.push(norm(f.webkitRelativePath).slice(1).join('/'));
        }
        return out;
    }
}

/** Folder configured on the local server / desktop app (read through its HTTP API). */
export class HttpFolder {
    constructor(path) {
        this.path = path;
        this.name = path.split(/[\\/]/).filter(Boolean).pop() || path;
    }

    async open(rel) {
        const q = `path=${encodeURIComponent(rel)}`;
        const res = await fetch(`api/game/stat?${q}`);
        if (!res.ok) return null;
        const { size } = await res.json();
        return {
            size,
            async read(offset = 0, length = size - offset) {
                const r = await fetch(`api/game/read?${q}&offset=${offset}&length=${length}`);
                if (!r.ok) throw new Error(`Could not read ${rel} (${r.status})`);
                return new Uint8Array(await r.arrayBuffer());
            },
        };
    }

    async list(relDir) {
        const res = await fetch(`api/game/list?dir=${encodeURIComponent(relDir)}`);
        return res.ok ? res.json() : [];
    }
}
