// PAWN code generation and import for model preview textdraws.

const f = (n) => {
    const s = Number(n).toFixed(4).replace(/0+$/, '');
    return s.endsWith('.') ? s + '0' : s;
};
const hex = (rgba) => '0x' + rgba.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

export function generate(s) {
    const v = s.varName || 'td';
    const P = s.player;
    const pre = P ? 'PlayerTextDraw' : 'TextDraw';
    const id = P ? `playerid, ${v}` : v;
    const lines = [
        `${v} = ${P ? 'CreatePlayerTextDraw(playerid, ' : 'TextDrawCreate('}${f(s.x)}, ${f(s.y)}, "_");`,
        `${pre}Font(${id}, TEXT_DRAW_FONT_MODEL_PREVIEW);`,
        `${pre}TextSize(${id}, ${f(s.width)}, ${f(s.height)});`,
        `${pre}BackgroundColor(${id}, ${hex(s.bg)});`,
        `${pre}SetPreviewModel(${id}, ${s.model});`,
        `${pre}SetPreviewRot(${id}, ${f(s.rx)}, ${f(s.ry)}, ${f(s.rz)}, ${f(s.zoom)});`,
    ];
    if (s.kind === 'vehicle') lines.push(`${pre}SetPreviewVehCol(${id}, ${s.c1}, ${s.c2});`);
    if (s.selectable) lines.push(`${pre}SetSelectable(${id}, true);`);
    return lines.join('\n');
}

export function rotLine(s) {
    const pre = s.player ? 'PlayerTextDraw' : 'TextDraw';
    const id = s.player ? `playerid, ${s.varName || 'td'}` : s.varName || 'td';
    return `${pre}SetPreviewRot(${id}, ${f(s.rx)}, ${f(s.ry)}, ${f(s.rz)}, ${f(s.zoom)});`;
}

const num = String.raw`(-?\d+(?:\.\d+)?)`;

function parseColor(str) {
    str = str.trim();
    let n;
    if (/^0x[0-9a-f]+$/i.test(str)) n = parseInt(str.slice(2), 16);
    else if (/^-?\d+$/.test(str)) n = Number(str) >>> 0;
    else return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** Extracts whatever it can from a pasted code snippet (TextDrawX or PlayerTextDrawX) */
export function parse(code) {
    const out = {};
    const args = (fn) => {
        const re = new RegExp(String.raw`(?:Player)?${fn}\s*\(([^;]*)\)\s*;`, 'i');
        const m = code.match(re);
        if (!m) return null;
        const parts = m[1].split(',').map((p) => p.trim());
        // drop "playerid" from PlayerTextDraw functions
        return /PlayerTextDraw|CreatePlayerTextDraw/i.test(m[0]) ? parts.slice(1) : parts;
    };
    let a;
    if ((a = args('TextDrawSetPreviewRot')) && a.length >= 4) {
        [out.rx, out.ry, out.rz] = a.slice(1, 4).map(Number);
        out.zoom = a[4] !== undefined ? Number(a[4]) : 1;
    }
    if ((a = args('TextDrawSetPreviewModel')) && /^\d+$/.test(a[1])) out.model = Number(a[1]);
    if ((a = args('TextDrawTextSize')) && a.length >= 3) [out.width, out.height] = [Number(a[1]), Number(a[2])];
    if ((a = args('TextDrawBackgroundColou?r')) && a.length >= 2) {
        const c = parseColor(a[1]);
        if (c) out.bg = c;
    }
    if ((a = args('TextDrawSetPreviewVehCol')) && a.length >= 3) [out.c1, out.c2] = [Number(a[1]), Number(a[2])];
    const create = code.match(new RegExp(String.raw`([\w\[\]]+)\s*=\s*(?:TextDrawCreate\s*\(|CreatePlayerTextDraw\s*\(\s*\w+\s*,)\s*${num}\s*,\s*${num}`, 'i'));
    if (create) {
        out.varName = create[1];
        out.x = Number(create[2]);
        out.y = Number(create[3]);
    }
    if (/PlayerTextDraw/i.test(code)) out.player = true;
    else if (/TextDraw/i.test(code)) out.player = false;
    for (const k of Object.keys(out)) if (typeof out[k] === 'number' && !Number.isFinite(out[k])) delete out[k];
    return out;
}
