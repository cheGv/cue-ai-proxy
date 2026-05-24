// lib/buildReportDocx.js
//
// Phase C — Cue Mirror Component Four (Word export).
//
// Pure docx-js renderer: takes the stored draft sections + the clinician's
// locked template length conventions and returns a .docx Buffer. No network,
// no DB, no LLM — separable so it can be unit-verified without auth/storage.
//
// Rendering rules (Component Four scope):
//   • Section title: Cambria 14pt bold. Body: Cambria 12pt, 1.5 spacing,
//     A4, 1" margins, centered header (format — client) + page-number footer.
//   • Cue's review scaffolding is STRIPPED: source_claims and lexicon_swaps
//     are never rendered. The stored `content` is already the neutral,
//     lexicon-swapped text, so no markers, footnotes, or swap UI appear.
//   • Placeholders: any bracketed "[...]" span renders with a yellow
//     highlight that the clinician's deletion removes with the text. A
//     static-clinician-authored section with no content renders a single
//     yellow-highlighted placeholder paragraph.
//   • Per-section shape follows the template's length convention:
//     'bulleted list' → bullets; everything else → paragraphs. A 'table'
//     section renders as paragraphs — the stored content is freeform text,
//     not a structured grid; the clinician formats the grid in Word.

const {
  Document, Packer, Paragraph, TextRun, Header, Footer,
  PageNumber, AlignmentType, LineRuleType,
  convertInchesToTwip, convertMillimetersToTwip,
} = require('docx');

const BODY_FONT = 'Cambria';
const BODY_SIZE = 24; // half-points → 12pt
const HEAD_SIZE = 28; // half-points → 14pt
const LINE_15 = 360;  // 1.5 line spacing (240 = single)
const PLACEHOLDER_RE = /\[[^\]]*\]/g;

// Split text into runs, highlighting bracketed placeholders yellow so the
// clinician's deletion of the placeholder removes the highlight with it.
function runsForText(text, { bold = false } = {}) {
  const runs = [];
  let last = 0;
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    if (m.index > last) {
      runs.push(new TextRun({ text: text.slice(last, m.index), font: BODY_FONT, size: BODY_SIZE, bold }));
    }
    runs.push(new TextRun({ text: m[0], font: BODY_FONT, size: BODY_SIZE, bold, highlight: 'yellow' }));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    runs.push(new TextRun({ text: text.slice(last), font: BODY_FONT, size: BODY_SIZE, bold }));
  }
  if (runs.length === 0) {
    runs.push(new TextRun({ text: '', font: BODY_FONT, size: BODY_SIZE, bold }));
  }
  return runs;
}

function bodyParagraph(text) {
  return new Paragraph({
    spacing: { after: 120, line: LINE_15, lineRule: LineRuleType.AUTO },
    children: runsForText(text),
  });
}

function bulletParagraph(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60, line: LINE_15, lineRule: LineRuleType.AUTO },
    children: runsForText(text.replace(/^\s*[-•*]\s+/, '')),
  });
}

function sectionHeading(name) {
  return new Paragraph({
    spacing: { before: 280, after: 120, line: LINE_15, lineRule: LineRuleType.AUTO },
    keepNext: true,
    children: [new TextRun({ text: name || 'Section', bold: true, font: BODY_FONT, size: HEAD_SIZE })],
  });
}

// Mirrors lib/models/format_draft.dart DraftSection.isStaticAuthored.
function isStaticAuthored(section) {
  const claims = Array.isArray(section.source_claims) ? section.source_claims : [];
  return claims.length === 1 && claims[0] && claims[0].source_type === 'static_clinician_authored';
}

function renderSectionBody(section, length) {
  const trimmed = (section.content || '').toString().trim();

  if (trimmed === '') {
    // Empty: a static-authored section is clinician-authored; either way keep
    // the structure with a yellow-highlighted placeholder paragraph.
    return [bodyParagraph(isStaticAuthored(section)
      ? '[To be authored by clinician]'
      : '[To be completed by clinician]')];
  }
  if (length === 'bulleted list') {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines.map(bulletParagraph) : [bodyParagraph(trimmed)];
  }
  // prose / paragraph / table / unknown → paragraphs (blank-line separated;
  // internal single newlines collapse to spaces).
  const paras = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  return (paras.length ? paras : [trimmed]).map(bodyParagraph);
}

// Flatten the template's section tree into { sectionName: lengthConvention }.
function buildLengthMap(extractedTemplate) {
  const map = {};
  const walk = (sections) => {
    if (!Array.isArray(sections)) return;
    for (const s of sections) {
      if (s && typeof s.name === 'string') map[s.name] = s.length || 'paragraph';
      if (s && Array.isArray(s.subsections)) walk(s.subsections);
    }
  };
  if (extractedTemplate && Array.isArray(extractedTemplate.sections)) {
    walk(extractedTemplate.sections);
  }
  return map;
}

async function buildReportDocx({ formatName, clientName, draftSections, extractedTemplate }) {
  const lengthByName = buildLengthMap(extractedTemplate);
  const docTitle = `${(formatName || 'Report').toString().trim()} — ${(clientName || 'Client').toString().trim()}`;

  const children = [];
  const sections = Array.isArray(draftSections) ? draftSections : [];
  for (const section of sections) {
    children.push(sectionHeading(section.section_name));
    const length = lengthByName[section.section_name] || 'paragraph';
    for (const p of renderSectionBody(section, length)) children.push(p);
  }
  if (children.length === 0) {
    children.push(bodyParagraph('[To be completed by clinician]'));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: BODY_FONT, size: BODY_SIZE } } } },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertMillimetersToTwip(210),
              height: convertMillimetersToTwip(297),
            },
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: docTitle, font: BODY_FONT, size: 20, color: '666666' })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT], font: BODY_FONT, size: 18, color: '666666' })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildReportDocx, isStaticAuthored, buildLengthMap };
