/* Regression test for the vendored tibetan-ansi-to-unicode RTF converter.

   Guards the Mac/Cocoa-RTF bug where converted Tibetan came out with a stray
   "?" (or U+FFFD) between every character — the \uc0 fallback chars leaking
   into the output. The fixture is the first paragraph of
   Thrangu_Sungtsom_Thorbu.rtf (BDRC IE3JT13381).

   Run:  node tests/test_rtf_convert.mjs    (exit 0 = pass) */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, "..", "web", "vendor", "tibetan-ansi-to-unicode", "src");
const { convertRtf } = await import(path.join(vendor, "parsers", "rtf.js"));
const { rtfToBlocks } = await import(path.join(vendor, "preview.js"));
const { convertRtfDocument } = await import(path.join(vendor, "transform", "rtf.js"));

const tib = (s) => [...s].filter((c) => c.charCodeAt(0) >= 0x0f00 && c.charCodeAt(0) <= 0x0fff).length;
const previewText = (raw) =>
  rtfToBlocks(raw).map((b) => b.runs.map((r) => r.text).join("")).join("\n");
const clean = (label, s, minTib) => {
  assert.ok(tib(s) > minTib, `${label}: expected Tibetan Unicode, got ${tib(s)} codepoints`);
  assert.ok(!s.includes("?"), `${label}: stray '?' fallback chars leaked`);
  assert.ok(!s.includes("�"), `${label}: U+FFFD replacement chars`);
};

// The web app reads RTF bytes as latin1 (see web/app.js readLatin1).
const rtf = fs.readFileSync(path.join(here, "fixtures", "thrangu-p1.rtf")).toString("latin1");

// 1. Parser path (convertRtf) on the legacy-byte source.
clean("convertRtf", convertRtf(rtf), 50);
// 2. Preview path (rtfToBlocks) — separate parser; this is what the app shows.
clean("rtfToBlocks", previewText(rtf), 50);
// 3. The exact production bug: re-uploading a converted .rtf. convertRtfDocument
//    emits \uc1 \uNNNN? escapes; the preview must skip the '?' fallbacks, not
//    leak "༄?༅?།?". (Legacy bytes alone never exercise \uc skipping.)
const reuploaded = convertRtfDocument(rtf);
assert.ok(reuploaded.includes("\\uc1"), "expected \\uc1 escapes in converted RTF");
clean("rtfToBlocks(reuploaded \\uc1?)", previewText(reuploaded), 50);

console.log(`ok — convertRtf + rtfToBlocks clean (legacy + \\uc1? re-upload), no '?' / U+FFFD`);
