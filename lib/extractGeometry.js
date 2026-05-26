// lib/extractGeometry.js
//
// Phase D week 2 — Cue Mirror format-mirroring engine: deterministic OOXML
// geometry extractor.
//
// PURE: takes a .docx Buffer, returns the structured visual geometry (page
// setup, fonts, ordered structure incl. tables + runs, numbering, and embedded
// media WITH raw bytes). No network, no DB, NO LLM — the LLM never sees format
// (Cue Mirror C2). The /format-extract-v2 endpoint handles download + media
// upload + persistence around this module, so this stays unit-testable.
//
// Units: DXA (twentieths of a point, 1440/in) for page/table/paragraph; EMU
// (914400/in) for drawing anchors/extents. Google-Docs exports emit decimal
// DXA ("115.0"); intAttr() rounds them.

const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

const EMU_PER_INCH = 914400;

// ── DOM helpers ──────────────────────────────────────────────────────────────
function parseXml(str) {
  return new DOMParser().parseFromString(str, 'text/xml');
}
function attr(el, name) {
  if (!el || !el.getAttribute) return null;
  const v = el.getAttribute(name);
  return v === '' ? null : v;
}
function intAttr(el, name) {
  const v = attr(el, name);
  if (v == null) return null;
  const n = parseFloat(v); // tolerate Google-Docs decimals
  return Number.isFinite(n) ? Math.round(n) : null;
}
function childElements(el, tagName) {
  const out = [];
  if (!el || !el.childNodes) return out;
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 1 && (!tagName || n.tagName === tagName)) out.push(n);
  }
  return out;
}
function firstChild(el, tagName) {
  const c = childElements(el, tagName);
  return c.length ? c[0] : null;
}
function firstDescendant(el, tagName) {
  if (!el || !el.getElementsByTagName) return null;
  const list = el.getElementsByTagName(tagName);
  return list && list.length ? list[0] : null;
}
function textOf(el) {
  let s = '';
  if (!el || !el.childNodes) return s;
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 3) s += n.nodeValue;
  }
  return s;
}
function boolProp(parent, tag) {
  const el = firstChild(parent, tag);
  if (!el) return false;
  const v = attr(el, 'w:val');
  return v == null || v === '1' || v === 'true' || v === 'on';
}

// Total tables in a block list, recursing into table cells (counts nested).
function countTables(blocks) {
  let n = 0;
  for (const b of blocks || []) {
    if (b && b.type === 'table') {
      n += 1;
      for (const row of b.rows) for (const c of row.cells) n += countTables(c.content);
    }
  }
  return n;
}

// ── relationships (rId → target) ─────────────────────────────────────────────
function parseRels(relsDoc) {
  const map = {};
  if (!relsDoc) return map;
  const list = relsDoc.getElementsByTagName('Relationship');
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    map[attr(r, 'Id')] = {
      target: attr(r, 'Target'),
      type: attr(r, 'Type'),
      mode: attr(r, 'TargetMode'),
    };
  }
  return map;
}

// ── page setup (document-level sectPr) ───────────────────────────────────────
function parsePageSetup(body) {
  // The doc-level sectPr is the last DIRECT child <w:sectPr> of <w:body>
  // (section-break sectPrs live inside <w:pPr> and are excluded here).
  const direct = childElements(body, 'w:sectPr');
  const sectPr = direct.length ? direct[direct.length - 1] : null;
  if (!sectPr) return null;
  const pgSz = firstChild(sectPr, 'w:pgSz');
  const pgMar = firstChild(sectPr, 'w:pgMar');
  const width = pgSz ? intAttr(pgSz, 'w:w') : null;
  const height = pgSz ? intAttr(pgSz, 'w:h') : null;
  let orientation = pgSz ? attr(pgSz, 'w:orient') : null;
  if (!orientation) orientation = width && height && width > height ? 'landscape' : 'portrait';
  const margins = pgMar
    ? {
        top: intAttr(pgMar, 'w:top'),
        bottom: intAttr(pgMar, 'w:bottom'),
        left: intAttr(pgMar, 'w:left'),
        right: intAttr(pgMar, 'w:right'),
        header: intAttr(pgMar, 'w:header'),
        footer: intAttr(pgMar, 'w:footer'),
      }
    : null;
  return { width, height, orientation, margins };
}

// ── default font (docDefaults → theme minorFont fallback) ────────────────────
function parseDefaultFont(stylesDoc, themeDoc) {
  let family = null;
  let size = null;
  if (stylesDoc) {
    const docDefaults = firstDescendant(stylesDoc.documentElement, 'w:docDefaults');
    const rPr = docDefaults ? firstDescendant(docDefaults, 'w:rPr') : null;
    if (rPr) {
      const rFonts = firstChild(rPr, 'w:rFonts');
      if (rFonts) family = attr(rFonts, 'w:ascii') || attr(rFonts, 'w:hAnsi') || null;
      const sz = firstChild(rPr, 'w:sz');
      if (sz) size = intAttr(sz, 'w:val'); // half-points
    }
  }
  if (!family && themeDoc) {
    const minor = firstDescendant(themeDoc.documentElement, 'a:minorFont');
    const latin = minor ? firstDescendant(minor, 'a:latin') : null;
    if (latin) family = attr(latin, 'typeface');
  }
  return { family: family || null, size: size || null };
}

// ── numbering.xml ────────────────────────────────────────────────────────────
function parseNumbering(numDoc) {
  if (!numDoc) return { abstract: {}, nums: {} };
  const root = numDoc.documentElement;
  const abstract = {};
  for (const an of childElements(root, 'w:abstractNum')) {
    const id = attr(an, 'w:abstractNumId');
    const levels = {};
    for (const lvl of childElements(an, 'w:lvl')) {
      const ilvl = attr(lvl, 'w:ilvl');
      const numFmt = firstChild(lvl, 'w:numFmt');
      const lvlText = firstChild(lvl, 'w:lvlText');
      const pPr = firstChild(lvl, 'w:pPr');
      const ind = pPr ? firstChild(pPr, 'w:ind') : null;
      levels[ilvl] = {
        numFmt: numFmt ? attr(numFmt, 'w:val') : null,
        text: lvlText ? attr(lvlText, 'w:val') : null,
        indent: ind
          ? { left: intAttr(ind, 'w:left'), hanging: intAttr(ind, 'w:hanging') }
          : null,
      };
    }
    abstract[id] = { levels };
  }
  const nums = {};
  for (const n of childElements(root, 'w:num')) {
    const id = attr(n, 'w:numId');
    const ab = firstChild(n, 'w:abstractNumId');
    nums[id] = ab ? attr(ab, 'w:val') : null;
  }
  return { abstract, nums };
}

// ── runs ─────────────────────────────────────────────────────────────────────
function parseRunProps(rPr) {
  const props = {};
  if (!rPr) return props;
  const rFonts = firstChild(rPr, 'w:rFonts');
  if (rFonts) {
    props.font = attr(rFonts, 'w:ascii') || attr(rFonts, 'w:hAnsi') || attr(rFonts, 'w:cs') || null;
    if (!props.font) delete props.font;
  }
  const sz = firstChild(rPr, 'w:sz');
  if (sz) props.size = intAttr(sz, 'w:val');
  if (boolProp(rPr, 'w:b')) props.bold = true;
  if (boolProp(rPr, 'w:i')) props.italic = true;
  const u = firstChild(rPr, 'w:u');
  if (u && attr(u, 'w:val') !== 'none') props.underline = true;
  const color = firstChild(rPr, 'w:color');
  if (color) {
    const c = attr(color, 'w:val');
    if (c && c !== 'auto') props.color = c;
  }
  const highlight = firstChild(rPr, 'w:highlight');
  if (highlight) {
    const h = attr(highlight, 'w:val');
    if (h && h !== 'none') props.highlight = h;
  }
  return props;
}

// Returns { text, ...props } OR { image } OR null.
function parseRunNode(r, ctx) {
  const drawing = firstDescendant(r, 'w:drawing');
  if (drawing) {
    const img = parseDrawing(drawing, ctx);
    return img ? { image: img } : null;
  }
  const props = parseRunProps(firstChild(r, 'w:rPr'));
  let text = '';
  for (const c of childElements(r)) {
    if (c.tagName === 'w:t') text += textOf(c);
    else if (c.tagName === 'w:tab') text += '\t';
    else if (c.tagName === 'w:br' || c.tagName === 'w:cr') text += '\n';
  }
  if (text === '' && Object.keys(props).length === 0) return null;
  return Object.assign({ text }, props);
}

function collectRuns(container, para, ctx) {
  for (const child of childElements(container)) {
    if (child.tagName === 'w:r') {
      const run = parseRunNode(child, ctx);
      if (!run) continue;
      if (run.image) para.images.push(run.image);
      else para.runs.push(run);
    } else if (child.tagName === 'w:hyperlink') {
      const relId = attr(child, 'r:id');
      const href = relId && ctx.rels[relId] ? ctx.rels[relId].target : null;
      const before = para.runs.length;
      collectRuns(child, para, ctx);
      if (href) for (let i = before; i < para.runs.length; i++) para.runs[i].href = href;
    }
  }
}

// ── drawings / images ────────────────────────────────────────────────────────
function parseDrawing(drawing, ctx) {
  const inline = firstDescendant(drawing, 'wp:inline');
  const anchor = firstDescendant(drawing, 'wp:anchor');
  const node = inline || anchor;
  if (!node) return null;
  const blip = firstDescendant(node, 'a:blip');
  const embed = blip ? attr(blip, 'r:embed') : null;
  const extent = firstDescendant(node, 'wp:extent');
  const cx = extent ? intAttr(extent, 'cx') : null;
  const cy = extent ? intAttr(extent, 'cy') : null;
  let x = 0;
  let y = 0;
  let wrap = inline ? 'inline' : 'anchor';
  if (anchor) {
    const ph = firstDescendant(anchor, 'wp:positionH');
    const pv = firstDescendant(anchor, 'wp:positionV');
    const phOff = ph ? firstDescendant(ph, 'wp:posOffset') : null;
    const pvOff = pv ? firstDescendant(pv, 'wp:posOffset') : null;
    x = phOff ? parseInt(textOf(phOff), 10) || 0 : 0;
    y = pvOff ? parseInt(textOf(pvOff), 10) || 0 : 0;
    if (attr(anchor, 'behindDoc') === '1') wrap = 'behindDoc';
  }
  const rel = embed && ctx.rels[embed] ? ctx.rels[embed].target : null;
  return {
    rel_id: embed,
    target: rel,
    anchor: { x, y, width: cx, height: cy },
    wrap_mode: wrap,
  };
}

// ── tables ───────────────────────────────────────────────────────────────────
function parseBorderSide(el) {
  if (!el) return null;
  return { style: attr(el, 'w:val'), size: intAttr(el, 'w:sz'), color: attr(el, 'w:color') };
}
function parseBorders(bordersEl) {
  if (!bordersEl) return null;
  const out = {};
  for (const side of ['top', 'bottom', 'left', 'right', 'insideH', 'insideV']) {
    const b = parseBorderSide(firstChild(bordersEl, `w:${side}`));
    if (b) out[side] = b;
  }
  return Object.keys(out).length ? out : null;
}

function parseTable(tbl, ctx) {
  const tblGrid = firstChild(tbl, 'w:tblGrid');
  const grid = tblGrid ? childElements(tblGrid, 'w:gridCol').map((g) => intAttr(g, 'w:w')) : [];
  const tblPr = firstChild(tbl, 'w:tblPr');
  const borders = tblPr ? parseBorders(firstChild(tblPr, 'w:tblBorders')) : null;
  const tblWidthEl = tblPr ? firstChild(tblPr, 'w:tblW') : null;
  const width = tblWidthEl ? intAttr(tblWidthEl, 'w:w') : null;
  const rows = [];
  for (const tr of childElements(tbl, 'w:tr')) {
    const cells = [];
    for (const tc of childElements(tr, 'w:tc')) {
      const tcPr = firstChild(tc, 'w:tcPr');
      const cell = { content: [] };
      if (tcPr) {
        const gs = firstChild(tcPr, 'w:gridSpan');
        if (gs) cell.gridSpan = intAttr(gs, 'w:val');
        const vm = firstChild(tcPr, 'w:vMerge');
        if (vm) cell.vMerge = attr(vm, 'w:val') || 'continue';
        const tcW = firstChild(tcPr, 'w:tcW');
        if (tcW) cell.width = intAttr(tcW, 'w:w');
        const shd = firstChild(tcPr, 'w:shd');
        if (shd) {
          const f = attr(shd, 'w:fill');
          if (f && f !== 'auto') cell.shading = f;
        }
        const va = firstChild(tcPr, 'w:vAlign');
        if (va) cell.vAlign = attr(va, 'w:val');
        const cb = parseBorders(firstChild(tcPr, 'w:tcBorders'));
        if (cb) cell.borders = cb;
      }
      for (const child of childElements(tc)) {
        if (child.tagName === 'w:p') cell.content.push(parseParagraph(child, ctx));
        else if (child.tagName === 'w:tbl') cell.content.push(parseTable(child, ctx));
      }
      cells.push(cell);
    }
    rows.push({ cells });
  }
  return { type: 'table', grid, width, borders, rows };
}

// ── paragraphs ───────────────────────────────────────────────────────────────
function parseParagraph(p, ctx) {
  const para = { type: 'paragraph', runs: [], images: [] };
  const pPr = firstChild(p, 'w:pPr');
  if (pPr) {
    const pStyle = firstChild(pPr, 'w:pStyle');
    if (pStyle) para.style = attr(pStyle, 'w:val');
    const jc = firstChild(pPr, 'w:jc');
    if (jc) para.alignment = attr(jc, 'w:val');
    const ind = firstChild(pPr, 'w:ind');
    if (ind) {
      para.indent = {
        left: intAttr(ind, 'w:left'),
        right: intAttr(ind, 'w:right'),
        firstLine: intAttr(ind, 'w:firstLine'),
        hanging: intAttr(ind, 'w:hanging'),
      };
    }
    const spacing = firstChild(pPr, 'w:spacing');
    if (spacing) {
      para.spacing = {
        before: intAttr(spacing, 'w:before'),
        after: intAttr(spacing, 'w:after'),
        line: intAttr(spacing, 'w:line'),
        lineRule: attr(spacing, 'w:lineRule'),
      };
    }
    const numPr = firstChild(pPr, 'w:numPr');
    if (numPr) {
      const ilvl = firstChild(numPr, 'w:ilvl');
      const numId = firstChild(numPr, 'w:numId');
      para.numbering = {
        ilvl: ilvl ? intAttr(ilvl, 'w:val') : 0,
        numId: numId ? intAttr(numId, 'w:val') : null,
      };
    }
  }
  collectRuns(p, para, ctx);
  return para;
}

// ── top-level ────────────────────────────────────────────────────────────────
async function extractGeometry(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);
  const readText = async (p) => {
    const f = zip.file(p);
    return f ? f.async('string') : null;
  };

  const docXml = await readText('word/document.xml');
  if (!docXml) throw new Error('word/document.xml not found — not a valid .docx');
  const stylesXml = await readText('word/styles.xml');
  const numberingXml = await readText('word/numbering.xml');
  const relsXml = await readText('word/_rels/document.xml.rels');
  const themeXml = await readText('word/theme/theme1.xml');

  const doc = parseXml(docXml);
  const stylesDoc = stylesXml ? parseXml(stylesXml) : null;
  const numDoc = numberingXml ? parseXml(numberingXml) : null;
  const relsDoc = relsXml ? parseXml(relsXml) : null;
  const themeDoc = themeXml ? parseXml(themeXml) : null;

  const ctx = { rels: parseRels(relsDoc) };
  const body = firstDescendant(doc.documentElement, 'w:body');

  const page_setup = parsePageSetup(body);
  const default_font = parseDefaultFont(stylesDoc, themeDoc);
  const numbering_definitions = parseNumbering(numDoc);

  // Ordered top-level structure (skip the doc-level sectPr).
  const structure = [];
  for (const child of childElements(body)) {
    if (child.tagName === 'w:p') structure.push(parseParagraph(child, ctx));
    else if (child.tagName === 'w:tbl') structure.push(parseTable(child, ctx));
  }

  // Media: every distinct embedded image (by rId) across the main document,
  // with raw bytes + anchor/extent. Header/footer images are folded in too so
  // the image count matches the source for logo-in-header layouts.
  const media = await collectMedia(zip, doc, ctx, readText);

  return {
    page_setup,
    default_font,
    numbering_definitions,
    structure,
    media,
    counts: {
      // Total <w:tbl> count INCLUDING nested tables (a nested table lives in a
      // cell's content) — matches a raw grep of the source.
      tables: countTables(structure),
      images: media.length,
      // Column count of the first top-level table — the raw tblGrid length.
      main_table_columns: (structure.find((s) => s.type === 'table') || { grid: [] }).grid.length,
    },
  };
}

async function collectMedia(zip, doc, ctx, readText) {
  const media = [];
  const seen = new Set();

  // Anchors keyed by rId, harvested from every <w:drawing> in the main doc.
  const anchorByRel = {};
  const drawings = doc.getElementsByTagName('w:drawing');
  for (let i = 0; i < drawings.length; i++) {
    const img = parseDrawing(drawings[i], ctx);
    if (img && img.rel_id) anchorByRel[img.rel_id] = { anchor: img.anchor, wrap_mode: img.wrap_mode };
  }

  // Main document blips (resolved through document.xml.rels).
  await harvestBlips(zip, doc, ctx.rels, anchorByRel, media, seen);

  // Header/footer parts (each has its own rels) — covers logo-in-header.
  const hfNames = Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n));
  for (const name of hfNames) {
    const xml = await readText(name);
    if (!xml) continue;
    const hfDoc = parseXml(xml);
    const relsName = name.replace(/word\//, 'word/_rels/') + '.rels';
    const relsXml = await readText(relsName);
    const rels = parseRels(relsXml ? parseXml(relsXml) : null);
    const localAnchors = {};
    const ds = hfDoc.getElementsByTagName('w:drawing');
    for (let i = 0; i < ds.length; i++) {
      const img = parseDrawing(ds[i], { rels });
      if (img && img.rel_id) localAnchors[img.rel_id] = { anchor: img.anchor, wrap_mode: img.wrap_mode };
    }
    await harvestBlips(zip, hfDoc, rels, localAnchors, media, seen, name);
  }

  return media;
}

async function harvestBlips(zip, scopeDoc, rels, anchorByRel, media, seen, partName) {
  const blips = scopeDoc.getElementsByTagName('a:blip');
  for (let i = 0; i < blips.length; i++) {
    const embed = attr(blips[i], 'r:embed');
    if (!embed) continue;
    const rel = rels[embed];
    if (!rel || !rel.target) continue;
    // Resolve target (relative to word/) to a zip path.
    let t = rel.target.replace(/^\.\//, '');
    let path;
    if (t.startsWith('/')) path = t.slice(1);
    else if (t.startsWith('word/')) path = t;
    else if (t.startsWith('../')) path = t.replace(/^\.\.\//, '');
    else path = `word/${t}`;
    if (seen.has(path)) continue;
    seen.add(path);
    const file = zip.file(path);
    if (!file) continue;
    const bytes = await file.async('nodebuffer');
    const ext = (path.split('.').pop() || 'png').toLowerCase();
    const a = anchorByRel[embed] || {};
    media.push({
      id: path.split('/').pop(),
      rel_id: embed,
      part: partName || 'document.xml',
      ext,
      bytes,
      anchor: a.anchor || null,
      wrap_mode: a.wrap_mode || null,
    });
  }
}

module.exports = {
  extractGeometry,
  EMU_PER_INCH,
  // exported for unit tests
  _internals: { parsePageSetup, parseDefaultFont, parseTable, parseParagraph, parseNumbering, parseRels, parseXml },
};
