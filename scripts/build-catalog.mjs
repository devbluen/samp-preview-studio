// Builds public/data/catalog.json (rows: [id, model, name, kind]) from the open.mp lists in data/,
// plus the SA-MP objects (18631+, from SAMP.ide) that open.mp doesn't list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

const rows = [];
for (const s of readJson('skins.json')) rows.push([s.id, s.model, s.name, 's']);
for (const v of readJson('vehicles.json')) rows.push([v.id, v.model, v.name, 'v']);
for (const o of readJson('objects.json')) rows.push([o.id, o.name, '', 'o']);
const known = new Set(rows.map((r) => r[0]));
for (const o of readJson('samp-objects.json')) if (!known.has(o.id)) rows.push([o.id, o.name.toLowerCase(), '', 'o']);
rows.sort((a, b) => a[0] - b[0]);
for (const r of rows) if (r[2] === r[1]) r[2] = '';

const out = path.join(ROOT, 'public', 'data', 'catalog.json');
fs.writeFileSync(out, JSON.stringify(rows));
console.log(`${rows.length} models -> ${path.relative(ROOT, out)}`);
