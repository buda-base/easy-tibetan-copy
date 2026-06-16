// Build a lightweight, formatting-aware preview model from a .docx or .rtf:
// an array of blocks (paragraphs), each { align, runs: [{ text, size, bold,
// italic }] }, with legacy Tibetan text already converted to Unicode. This lets
// a UI render a faithful "what the document will look like" preview (big/small
// sizes, bold, paragraph flow) without a full Office renderer.

import { getBudaTable } from "./fonts.js";
import { isMacRtf, isSym, symLegacyChar, SYM_CHAR } from "./rtf-symbols.js";

function convert(text, table) {
  if (!table) return text;
  let r = "";
  for (const ch of text) {
    const u = table[ch.codePointAt(0)];
    r += u !== undefined ? u : ch;
  }
  return r;
}

// ---------- DOCX ----------
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}
function attr(tag, name) {
  const m = tag && tag.match(new RegExp("\\b" + name + '="([^"]*)"'));
  return m ? m[1] : null;
}
const ALIGN = { both: "justify", center: "center", right: "right", left: "left", start: "left", end: "right" };

// Prefer the rFonts slot that is a known legacy font (ascii/hAnsi before cs).
function pickFont(rFontsTag, fallback) {
  if (!rFontsTag) return fallback;
  const a = attr(rFontsTag, "w:ascii");
  const h = attr(rFontsTag, "w:hAnsi");
  const c = attr(rFontsTag, "w:cs");
  for (const f of [a, h, c]) if (f && getBudaTable(f)) return f;
  return a || h || c || fallback;
}

function docDefaultFont(stylesXml) {
  if (!stylesXml) return null;
  const dd = stylesXml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/);
  const rf = (dd ? dd[0] : "").match(/<w:rFonts\b[^>]*\/?>/);
  if (!rf) return null;
  const f = attr(rf[0], "w:cs") || attr(rf[0], "w:ascii") || attr(rf[0], "w:hAnsi");
  return f && getBudaTable(f) ? f : null;
}

function paragraphFromXml(inner, fallbackFont) {
  const align = ALIGN[(inner.match(/<w:jc w:val="(\w+)"/) || [])[1]] || "left";
  const runs = [];
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let rm;
  while ((rm = runRe.exec(inner))) {
    const r = rm[1];
    const rf = r.match(/<w:rFonts\b[^>]*\/?>/);
    const font = pickFont(rf && rf[0], fallbackFont);
    let text = "";
    const tokRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>/g;
    let tk;
    while ((tk = tokRe.exec(r))) text += tk[1] !== undefined ? decodeEntities(tk[1]) : "\t";
    if (!text) continue;
    const table = font && getBudaTable(font);
    const szm = r.match(/<w:szCs w:val="(\d+)"/) || r.match(/<w:sz w:val="(\d+)"/);
    const bm = r.match(/<w:b\b([^>]*)\/>/);
    const im = r.match(/<w:i\b([^>]*)\/>/);
    const off = (a) => a && /w:val="(0|false|off)"/.test(a[1]);
    runs.push({
      text: convert(text, table),
      size: szm ? parseInt(szm[1], 10) / 2 : null,
      bold: !!bm && !off(bm),
      italic: !!im && !off(im),
    });
  }
  return { align, runs };
}

export async function docxToBlocks(data) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  const doc = zip.file("word/document.xml");
  if (!doc) throw new Error("Not a Word .docx");
  const xml = await doc.async("string");
  const stylesFile = zip.file("word/styles.xml");
  const fallback = stylesFile ? docDefaultFont(await stylesFile.async("string")) : null;
  const blocks = [];
  const paraRe = /<w:p\b[^>]*?\/>|<w:p\b[^>]*?>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = paraRe.exec(xml))) {
    blocks.push(m[1] === undefined ? { align: "left", runs: [] } : paragraphFromXml(m[1], fallback));
  }
  return blocks;
}

// ---------- RTF ----------
const IGNORE_DEST = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata",
  "colorschememapping", "latentstyles", "datastore", "listtable",
  "listoverridetable", "rsidtbl", "generator", "filetbl",
]);


function rtfFonts(rtf) {
  const at = rtf.indexOf("\\fonttbl");
  if (at < 0) return {};
  const gs = rtf.lastIndexOf("{", at);
  let depth = 0, ge = -1;
  for (let i = gs; i < rtf.length; i++) {
    if (rtf[i] === "{") depth++;
    else if (rtf[i] === "}") { depth--; if (depth === 0) { ge = i; break; } }
  }
  const group = rtf.slice(gs, ge + 1);
  const fonts = {};
  const re = /\\f(\d+)\b[^;{}]*?(?:\\[a-z]+-?\d* ?)*\s*([^;{}]*);/gi;
  let m;
  while ((m = re.exec(group))) {
    const name = (m[2] || "").replace(/\\[a-z]+-?\d* ?/gi, "").trim();
    if (name) fonts[parseInt(m[1], 10)] = name;
  }
  return fonts;
}

export function rtfToBlocks(rtf) {
  rtf = String(rtf);
  const mac = isMacRtf(rtf);
  const fonts = rtfFonts(rtf);
  const tableFor = (id) => (fonts[id] ? getBudaTable(fonts[id]) : null);

  const blocks = [];
  let para = { align: "left", runs: [] };
  let run = { text: "", font: null, size: null, bold: false, italic: false };
  const st = [{ font: null, size: null, bold: false, italic: false, ignore: false }];
  const cur = () => st[st.length - 1];
  let ucSkip = 1, skipChars = 0; // \ucN: fallback chars to drop after each \uN

  function flushRun() {
    if (run.text) {
      para.runs.push({
        text: convert(run.text, tableFor(run.font)),
        size: run.size,
        bold: run.bold,
        italic: run.italic,
      });
    }
    run = { text: "", font: cur().font, size: cur().size, bold: cur().bold, italic: cur().italic };
  }
  function sync() {
    const c = cur();
    if (run.text && (run.font !== c.font || run.size !== c.size || run.bold !== c.bold || run.italic !== c.italic))
      flushRun();
    if (!run.text) { run.font = c.font; run.size = c.size; run.bold = c.bold; run.italic = c.italic; }
  }
  function endPara() {
    flushRun();
    blocks.push(para);
    para = { align: "left", runs: [] };
  }
  function add(ch) {
    if (cur().ignore) return;
    if (skipChars > 0) { skipChars--; return; } // \uN fallback char: drop it
    sync();
    run.text += ch;
  }

  // body after fonttbl
  const at = rtf.indexOf("\\fonttbl");
  let start = 0;
  if (at >= 0) {
    const gs = rtf.lastIndexOf("{", at);
    let depth = 0;
    for (let i = gs; i < rtf.length; i++) {
      if (rtf[i] === "{") depth++;
      else if (rtf[i] === "}") { depth--; if (depth === 0) { start = i + 1; break; } }
    }
  }
  const s = rtf, n = s.length;
  let i = start;
  while (i < n) {
    const c = s[i];
    if (c === "{") { st.push({ ...cur() }); i++; }
    else if (c === "}") { if (st.length > 1) st.pop(); i++; }
    else if (c === "\\") {
      const next = s[i + 1];
      if (next === "'") { add(String.fromCharCode(parseInt(s.substr(i + 2, 2), 16))); i += 4; }
      else if (next === "\\" || next === "{" || next === "}") { add(next); i += 2; }
      else if (/[a-zA-Z]/.test(next)) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(s[j])) j++;
        const word = s.slice(i + 1, j);
        let num = "";
        if (s[j] === "-") { num += "-"; j++; }
        while (j < n && /[0-9]/.test(s[j])) { num += s[j]; j++; }
        if (s[j] === " ") j++;
        const c0 = cur();
        if (word === "par" || word === "sect") endPara();
        else if (word === "line") add("\n");
        else if (word === "tab") add("\t");
        else if (word === "f" && num !== "") c0.font = parseInt(num, 10);
        else if (word === "fs" && num !== "") c0.size = parseInt(num, 10) / 2;
        else if (word === "b") c0.bold = num !== "0";
        else if (word === "i") c0.italic = num !== "0";
        else if (word === "plain") { c0.bold = false; c0.italic = false; }
        else if (word === "pard") para.align = "left";
        else if (word === "qc") para.align = "center";
        else if (word === "qr") para.align = "right";
        else if (word === "qj") para.align = "justify";
        else if (word === "ql") para.align = "left";
        else if (IGNORE_DEST.has(word.toLowerCase())) c0.ignore = true;
        else if (isSym(word)) add(tableFor(c0.font) ? symLegacyChar(word, mac) : SYM_CHAR[word]);
        else if (word === "uc") { ucSkip = parseInt(num || "1", 10); }
        else if (word === "u" && num !== "") { add(String.fromCodePoint(parseInt(num, 10) & 0xffff)); skipChars = ucSkip; }
        i = j;
      } else { i += 2; }
    } else if (c === "\r" || c === "\n") { i++; }
    else { add(c); i++; }
  }
  endPara();
  return blocks.filter((b, idx) => b.runs.length || idx < blocks.length - 1);
}
