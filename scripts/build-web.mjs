// Builds the static site in dist/ (GitHub Pages): public/ plus the three.js files the page imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const THREE = path.join(ROOT, 'node_modules', 'three');

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
for (const rel of ['build/three.module.js', 'examples/jsm/controls/OrbitControls.js', 'examples/jsm/controls/TransformControls.js']) {
    const out = path.join(DIST, 'vendor', 'three', rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(path.join(THREE, rel), out);
}
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
console.log(`Static site -> ${path.relative(ROOT, DIST)}/`);
