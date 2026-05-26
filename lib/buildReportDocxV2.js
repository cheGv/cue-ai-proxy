// lib/buildReportDocxV2.js
//
// Phase D week 2 — Cue Mirror format-mirroring engine: deterministic renderer.
//
// Reconstructs a .docx from the geometry produced by extractGeometry.js, via
// docx-js. The output reproduces the source's exact page setup, ordered
// structure, tables (column widths + gridSpan→columnSpan + vMerge→rowSpan,
// borders, shading), per-run formatting (font/size/bold/italic/underline/
// colour/highlight — IPA and any unicode preserved verbatim), faithful
// numbering, and floating/inline images at their EMU anchors.
//
// PRINCIPLE (Cue Mirror C2): structure is reconstructed deterministically here;
// the LLM never sees format. Content injection (per-client text) happens via an
// optional `textTransform` hook — by default we render the template verbatim,
// which is exactly what the round-trip gate (E2) asserts against the source.
//
// PURE: no network, no DB. Media bytes are passed in on geometry.media[i].bytes
// (the /format-draft-export path downloads them from format_template_media and
// populates bytes before calling). Returns a Buffer.

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, PageOrientation, WidthType, BorderStyle, ShadingType,
  VerticalAlign, LevelFormat, TextWrappingType,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
} = require('docx');

const EMU_PER_PX = 9525; // docx-js transformation width/height are in px (px*9525 = EMU)

// ── small mappers ────────────────────────────────────────────────────────────
function alignOf(val) {
  switch (val) {
    case 'center': return AlignmentType.CENTER;
    case 'right': return AlignmentType.RIGHT;
    case 'both':
    case 'justify': return AlignmentType.JUSTIFIED;
    case 'left': return AlignmentType.LEFT;
    default: return undefined;
  }
}
function borderStyleOf(val) {
  switch ((val || '').toLowerCase()) {
    case 'single': return BorderStyle.SINGLE;
    case 'double': return BorderStyle.DOUBLE;
    case 'dashed': return BorderStyle.DASHED;
    case 'dotted': return BorderStyle.DOTTED;
    case 'thick': return BorderStyle.THICK;
    case 'none':
    case 'nil': return BorderStyle.NONE;
    default: return BorderStyle.SINGLE;
  }
}
function levelFormatOf(numFmt) {
  switch (numFmt) {
    case 'bullet': return LevelFormat.BULLET;
    case 'decimal': return LevelFormat.DECIMAL;
    case 'lowerRoman': return LevelFormat.LOWER_ROMAN;
    case 'upperRoman': return LevelFormat.UPPER_ROMAN;
    case 'lowerLetter': return LevelFormat.LOWER_LETTER;
    case 'upperLetter': return LevelFormat.UPPER_LETTER;
    default: return LevelFormat.DECIMAL;
  }
}
function imageTypeOf(ext) {
  const e = (ext || 'png').toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'jpg';
  if (e === 'gif') return 'gif';
  if (e === 'bmp') return 'bmp';
  if (e === 'svg') return 'svg';
  return 'png';
}

// ── borders ──────────────────────────────────────────────────────────────────
function mapBorders(b) {
  if (!b) return undefined;
  const out = {};
  for (const side of ['top', 'bottom', 'left', 'right', 'insideH', 'insideV']) {
    const s = b[side];
    if (s && s.style) {
      out[side] = {
        style: borderStyleOf(s.style),
        size: typeof s.size === 'number' ? s.size : 4,
        color: s.color && s.color !== 'auto' ? s.color : '000000',
      };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// ── runs ─────────────────────────────────────────────────────────────────────
function textRunsFor(runs, textTransform) {
  const out = [];
  for (const r of runs || []) {
    let text = r.text != null ? String(r.text) : '';
    if (textTransform) text = textTransform(text);
    // docx-js: a literal newline is invalid; split into break runs.
    const segments = text.split('\n');
    for (let i = 0; i < segments.length; i++) {
      out.push(new TextRun({
        text: segments[i],
        break: i > 0 ? 1 : undefined,
        font: r.font || undefined,
        size: typeof r.size === 'number' ? r.size : undefined, // half-points, as source
        bold: r.bold || undefined,
        italics: r.italic || undefined,
        underline: r.underline ? {} : undefined,
        color: r.color || undefined,
        highlight: r.highlight || undefined,
      }));
    }
  }
  if (out.length === 0) out.push(new TextRun({ text: '' }));
  return out;
}

// ── images ───────────────────────────────────────────────────────────────────
function imageRunFor(media) {
  if (!media || !media.bytes) return null;
  const a = media.anchor || {};
  const wPx = a.width ? Math.max(1, Math.round(a.width / EMU_PER_PX)) : 100;
  const hPx = a.height ? Math.max(1, Math.round(a.height / EMU_PER_PX)) : 100;
  const opts = {
    type: imageTypeOf(media.ext),
    data: media.bytes,
    transformation: { width: wPx, height: hPx },
    altText: { title: 'template image', description: 'mirrored template image', name: media.id || 'image' },
  };
  const wrap = media.wrap_mode;
  if (wrap && wrap !== 'inline') {
    opts.floating = {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(a.x || 0) },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round(a.y || 0) },
      allowOverlap: true,
      behindDocument: wrap === 'behindDoc',
      wrap: { type: TextWrappingType.NONE },
    };
  }
  return new ImageRun(opts);
}

// ── paragraphs ───────────────────────────────────────────────────────────────
function paragraphFor(block, ctx) {
  const children = textRunsFor(block.runs, ctx.textTransform);
  for (const img of block.images || []) {
    const ir = imageRunFor(resolveMedia(img, ctx));
    if (ir) children.push(ir);
  }
  const opts = { children };
  const a = alignOf(block.alignment);
  if (a !== undefined) opts.alignment = a;
  if (block.indent) {
    opts.indent = {};
    if (block.indent.left != null) opts.indent.left = block.indent.left;
    if (block.indent.right != null) opts.indent.right = block.indent.right;
    if (block.indent.firstLine != null) opts.indent.firstLine = block.indent.firstLine;
    if (block.indent.hanging != null) opts.indent.hanging = block.indent.hanging;
  }
  if (block.spacing) {
    opts.spacing = {};
    if (block.spacing.before != null) opts.spacing.before = block.spacing.before;
    if (block.spacing.after != null) opts.spacing.after = block.spacing.after;
    if (block.spacing.line != null) opts.spacing.line = block.spacing.line;
  }
  if (block.numbering && block.numbering.numId != null && ctx.numRefs.has(`num${block.numbering.numId}`)) {
    opts.numbering = { reference: `num${block.numbering.numId}`, level: block.numbering.ilvl || 0 };
  }
  return new Paragraph(opts);
}

// Anchored images attached to the document body but not to a specific run are
// referenced by media entry; floating images render fine inside any paragraph.
function resolveMedia(imgRef, ctx) {
  // imgRef is a {rel_id, target, anchor, wrap_mode} from a paragraph's images[]
  const m = ctx.mediaByRel[imgRef.rel_id];
  if (m) return Object.assign({}, m, { anchor: imgRef.anchor || m.anchor, wrap_mode: imgRef.wrap_mode || m.wrap_mode });
  return null;
}

// ── tables (grid reconstruction: gridSpan→columnSpan, vMerge→rowSpan) ─────────
function buildCellModel(tableBlock) {
  const rows = tableBlock.rows || [];
  const model = rows.map(() => []);
  const openByCol = {}; // colStart -> { r, i } of the open restart cell
  for (let r = 0; r < rows.length; r++) {
    let col = 0;
    for (const cell of rows[r].cells || []) {
      const colSpan = cell.gridSpan || 1;
      const colStart = col;
      col += colSpan;
      if (cell.vMerge === 'continue') {
        const open = openByCol[colStart];
        if (open) {
          model[open.r][open.i].rowSpan += 1;
          model[r].push({ cell, colStart, colSpan, rowSpan: 1, drop: true });
          continue;
        }
        // orphan continue → treat as a normal cell
      }
      const entry = { cell, colStart, colSpan, rowSpan: 1, drop: false };
      model[r].push(entry);
      if (cell.vMerge === 'restart') openByCol[colStart] = { r, i: model[r].length - 1 };
      else delete openByCol[colStart];
    }
  }
  return model;
}

function tableFor(tableBlock, ctx) {
  const grid = (tableBlock.grid || []).map((w) => (typeof w === 'number' ? w : 0));
  const model = buildCellModel(tableBlock);
  const docRows = [];
  for (let r = 0; r < model.length; r++) {
    const cells = [];
    for (const entry of model[r]) {
      if (entry.drop) continue;
      const { cell, colStart, colSpan, rowSpan } = entry;
      let cellWidth = cell.width;
      if (cellWidth == null) {
        cellWidth = 0;
        for (let c = colStart; c < colStart + colSpan && c < grid.length; c++) cellWidth += grid[c] || 0;
      }
      const childBlocks = [];
      for (const cb of cell.content || []) {
        if (cb.type === 'paragraph') childBlocks.push(paragraphFor(cb, ctx));
        else if (cb.type === 'table') childBlocks.push(tableFor(cb, ctx));
      }
      if (childBlocks.length === 0) childBlocks.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
      const cellOpts = {
        children: childBlocks,
        columnSpan: colSpan > 1 ? colSpan : undefined,
        rowSpan: rowSpan > 1 ? rowSpan : undefined,
        width: cellWidth ? { size: cellWidth, type: WidthType.DXA } : undefined,
        verticalAlign: cell.vAlign === 'center' ? VerticalAlign.CENTER
          : cell.vAlign === 'bottom' ? VerticalAlign.BOTTOM : undefined,
        borders: mapBorders(cell.borders),
      };
      if (cell.shading) cellOpts.shading = { fill: cell.shading, type: ShadingType.CLEAR, color: 'auto' };
      cells.push(new TableCell(cellOpts));
    }
    if (cells.length === 0) cells.push(new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '' })] })] }));
    docRows.push(new TableRow({ children: cells }));
  }
  const totalWidth = grid.reduce((a, b) => a + (b || 0), 0);
  const opts = { rows: docRows };
  if (grid.length) opts.columnWidths = grid;
  if (totalWidth) opts.width = { size: totalWidth, type: WidthType.DXA };
  const tb = mapBorders(tableBlock.borders);
  if (tb) opts.borders = tb;
  return new Table(opts);
}

// ── numbering configs from numbering_definitions ─────────────────────────────
function buildNumbering(numDefs) {
  const config = [];
  const refs = new Set();
  if (!numDefs || !numDefs.nums) return { config, refs };
  for (const numId of Object.keys(numDefs.nums)) {
    const abstractId = numDefs.nums[numId];
    const abstract = numDefs.abstract && numDefs.abstract[abstractId];
    if (!abstract || !abstract.levels) continue;
    const levels = [];
    for (let lvl = 0; lvl < 9; lvl++) {
      const def = abstract.levels[String(lvl)];
      if (!def) continue;
      const indent = def.indent || {};
      levels.push({
        level: lvl,
        format: levelFormatOf(def.numFmt),
        text: def.text || (def.numFmt === 'bullet' ? '•' : `%${lvl + 1}.`),
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: {
          left: indent.left != null ? indent.left : 720 * (lvl + 1),
          hanging: indent.hanging != null ? indent.hanging : 360,
        } } },
      });
    }
    if (levels.length) {
      const ref = `num${numId}`;
      config.push({ reference: ref, levels });
      refs.add(ref);
    }
  }
  return { config, refs };
}

// ── top-level ────────────────────────────────────────────────────────────────
async function buildReportDocxV2({ geometry, textTransform }) {
  const g = geometry || {};
  const ps = g.page_setup || {};
  const margins = ps.margins || {};

  // Page size: emit the source's exact pgSz. docx-js swaps width/height for
  // LANDSCAPE, so pass the short edge as width + long edge as height there.
  const srcW = ps.width || 12240;
  const srcH = ps.height || 15840;
  const isLandscape = (ps.orientation || 'portrait') === 'landscape';
  const pageSize = isLandscape
    ? { width: Math.min(srcW, srcH), height: Math.max(srcW, srcH), orientation: PageOrientation.LANDSCAPE }
    : { width: srcW, height: srcH, orientation: PageOrientation.PORTRAIT };

  // media indexed by rel_id for in-paragraph image resolution
  const mediaByRel = {};
  for (const m of g.media || []) if (m.rel_id) mediaByRel[m.rel_id] = m;

  const { config: numConfig, refs: numRefs } = buildNumbering(g.numbering_definitions);
  const ctx = { mediaByRel, numRefs, textTransform };

  // Body children in source order. Images (inline or floating/behindDoc) are
  // attached to the paragraph run that carries them in the source, so
  // paragraphFor emits them in position — no separate media injection, which
  // would double-emit and break the image-count invariant.
  const children = [];
  for (const block of g.structure || []) {
    if (block.type === 'paragraph') children.push(paragraphFor(block, ctx));
    else if (block.type === 'table') children.push(tableFor(block, ctx));
  }
  if (children.length === 0) children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));

  const docOpts = {
    sections: [{
      properties: {
        page: {
          size: pageSize,
          margin: {
            top: margins.top != null ? margins.top : 1440,
            bottom: margins.bottom != null ? margins.bottom : 1440,
            left: margins.left != null ? margins.left : 1440,
            right: margins.right != null ? margins.right : 1440,
            header: margins.header != null ? margins.header : 720,
            footer: margins.footer != null ? margins.footer : 720,
          },
        },
      },
      children,
    }],
  };
  if (numConfig.length) docOpts.numbering = { config: numConfig };

  const df = g.default_font || {};
  if (df.family || df.size) {
    docOpts.styles = { default: { document: { run: {
      font: df.family || undefined,
      size: df.size || undefined,
    } } } };
  }

  const doc = new Document(docOpts);
  return Packer.toBuffer(doc);
}

module.exports = { buildReportDocxV2, EMU_PER_PX, _internals: { buildCellModel, buildNumbering } };
