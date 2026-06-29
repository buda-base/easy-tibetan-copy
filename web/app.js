/* Easy Tibetan Copy : front-end state machine (100% client-side, no server) */
const App = (() => {
  const views = ['upload', 'config', 'processing', 'result', 'error'];
  const $ = (id) => document.getElementById(id);
  const WARN_MB = 20;

  let state = {};

  // ---- helpers -------------------------------------------------------------
  function showView(name) {
    views.forEach((v) => { $('view-' + v).hidden = v !== name; });
    const el = $('view-' + name);
    el.classList.remove('swap-enter'); void el.offsetWidth; el.classList.add('swap-enter');
  }

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function esc(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function download(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function baseName() {
    return (state.filename || 'document').replace(/\.pdf$/i, '');
  }

  // ---- the engine (Pyodide in a Web Worker) --------------------------------
  let worker = null;
  let pending = null;

  function engine() {
    if (worker) return worker;
    worker = new Worker('worker.js?v=__BUILD__');
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { onPhase(m.phase); return; }
      if (m.type === 'error') {
        const p = pending; pending = null;
        if (p) p.reject(new Error(m.message));
        return;
      }
      const p = pending; pending = null;
      if (p) p.resolve(m);
    };
    worker.onerror = (e) => {
      const p = pending; pending = null;
      if (p) p.reject(new Error(e.message || 'Engine crashed (the file may be too large).'));
    };
    return worker;
  }

  function call(type, payload = {}, transfer) {
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      engine().postMessage({ type, ...payload }, transfer || []);
    });
  }

  function onPhase(phase) {
    const map = {
      booting: 'Starting the engine…',
      'loading-packages': 'Loading the PDF toolkit…',
      installing: 'Loading the Tibetan fixer…',
      ready: 'Engine ready.',
      working: 'Working on your document…',
    };
    const sub = $('proc-sub');
    if (sub && map[phase]) sub.textContent = map[phase];
  }

  // ---- init ----------------------------------------------------------------
  function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    wireDropzone();
    showView('upload');
  }

  function wireDropzone() {
    const drop = $('drop'); const input = $('file');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    window.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData?.files || [])][0]; if (f) handleFile(f);
    });
  }

  // ---- step 1: read + analyze (locally) ------------------------------------
  function fileKind(file) {
    const n = (file.name || '').toLowerCase();
    if (n.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
    if (n.endsWith('.docx')) return 'docx';
    if (n.endsWith('.rtf') || file.type === 'application/rtf' || file.type === 'text/rtf') return 'rtf';
    if (n.endsWith('.doc')) return 'doc';
    return 'unknown';
  }

  // The Word/RTF converter (tibetan-ansi-to-unicode) is a separate JS module,
  // loaded on demand — it needs no Pyodide, so docx/rtf stay lightweight.
  let _lib = null;
  function loadLib() {
    if (!_lib) _lib = import('./vendor/tibetan-ansi-to-unicode/index.js?v=__BUILD__');
    return _lib;
  }

  function prepProcessing() {
    const m = document.querySelector('#view-processing .mandala'); if (m) m.style.display = '';
    const a = document.querySelector('#view-processing .notice-actions'); if (a) a.remove();
  }

  async function handleFile(file) {
    const kind = fileKind(file);
    if (kind === 'doc') return noticeDoc();
    if (kind === 'unknown') return toast('Please choose a PDF, Word (.docx) or RTF file.');

    state = { filename: file.name, kind, mode: 'fix', pages: 'all' };

    const mb = file.size / 1048576;
    if (mb > WARN_MB && !file._confirmed) return renderSizeWarning(file, mb);

    if (kind === 'pdf') return startPdf(file);
    return convertDoc(file, kind);
  }

  async function startPdf(file) {
    prepProcessing();
    $('proc-title').textContent = 'Reading your document…';
    $('proc-sub').textContent = 'Warming up the engine…';
    showView('processing');
    try {
      const buf = await file.arrayBuffer();
      // Transfer the buffer to the worker; it keeps /in.pdf in its FS for fix/extract.
      const a = await call('analyze', { bytes: buf }, [buf]);
      state.analysis = a;
      // No extractable text means the pages are scans/images (or blank). Nothing
      // to fix or extract — say so plainly instead of running an empty pass.
      if (!a.has_text) return renderScannedNotice(a);
      renderConfig();
    } catch (err) { showError(err.message); }
  }

  // ---- Word/RTF: convert legacy Tibetan to Unicode, in place ---------------
  function readLatin1(buf) {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return s;
  }
  function latin1Bytes(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }
  function adaptBlocks(blocks) {
    return (blocks || []).map((b) => ({
      lines: [(b.runs || []).map((r) => ({ t: r.text, s: r.size, b: r.bold, i: r.italic }))],
    }));
  }
  async function convertDoc(file, kind) {
    prepProcessing();
    $('proc-title').textContent = 'Converting to Unicode…';
    $('proc-sub').textContent = 'Reading your document…';
    showView('processing');
    try {
      const lib = await loadLib();
      let outBytes, blocks, mime, ext;
      if (kind === 'docx') {
        const data = new Uint8Array(await file.arrayBuffer());
        [outBytes, blocks] = await Promise.all([lib.convertDocxDocument(data), lib.docxToBlocks(data)]);
        mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; ext = 'docx';
      } else {
        const rtf = readLatin1(await file.arrayBuffer());
        outBytes = latin1Bytes(lib.convertRtfDocument(rtf));
        blocks = lib.rtfToBlocks(rtf);
        mime = 'application/rtf'; ext = 'rtf';
      }
      renderConvertResult({ outBytes, blocks, mime, ext });
    } catch (err) { showError(err.message); }
  }

  function renderSizeWarning(file, mb) {
    showView('processing');
    $('proc-title').textContent = 'Large file';
    $('proc-sub').textContent = `This PDF is ${mb.toFixed(0)} MB. Everything runs in your browser, and large files can use a lot of memory — the tab may run out of memory and crash. A desktop computer is recommended.`;
    const sub = $('proc-sub');
    const actions = document.createElement('div');
    actions.className = 'btn-actions';
    actions.style.justifyContent = 'center';
    actions.style.marginTop = '16px';
    actions.innerHTML = `
      <button class="btn btn-ghost" id="warn-cancel">Choose another</button>
      <button class="btn btn-primary" id="warn-go">Continue anyway</button>`;
    sub.after(actions);
    $('warn-cancel').onclick = () => reset();
    $('warn-go').onclick = () => { actions.remove(); file._confirmed = true; handleFile(file); };
  }

  function noticeDoc() {
    prepProcessing();
    const m = document.querySelector('#view-processing .mandala'); if (m) m.style.display = 'none';
    $('proc-title').textContent = 'This is an old “.doc” file';
    $('proc-sub').innerHTML = 'Easy Tibetan Copy handles modern <b>.docx</b> files. Open this <b>.doc</b> in a recent Microsoft Word, choose <b>File → Save As → Word Document (.docx)</b>, then drop the <b>.docx</b> here.';
    const actions = document.createElement('div');
    actions.className = 'btn-actions notice-actions';
    actions.style.justifyContent = 'center'; actions.style.marginTop = '18px';
    actions.innerHTML = '<button class="btn btn-quiet" id="notice-back">Choose another file</button>';
    $('proc-sub').after(actions);
    $('notice-back').onclick = () => reset();
    showView('processing');
  }

  function renderConvertResult({ outBytes, blocks, mime, ext }) {
    const rich = renderBlocks(adaptBlocks(blocks));
    const text = (blocks || []).map((b) => (b.runs || []).map((r) => r.text).join('')).join('\n');
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">
          <div class="badge-ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></div>
          <div><h3>Converted to Unicode</h3><p>Your Tibetan is now real Unicode — copy, paste and search. All other formatting is kept.</p></div>
        </div>
        <div class="texttools"><span class="fmt">${words.toLocaleString()} words</span></div>
        <div class="textbox rich" id="textbox">${rich || '<span style="color:var(--ink-faint)">No legacy Tibetan found to convert.</span>'}</div>
        <div class="btn-actions" style="flex-wrap:wrap">
          <button class="btn btn-primary" id="dl-doc"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg> Download .${ext}</button>
          <button class="btn btn-ghost" id="copy"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>
          <button class="btn btn-ghost" id="save"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg> .txt</button>
          <button class="btn btn-quiet" onclick="App.reset()" style="margin-left:auto">Do another</button>
        </div>
      </div>`;
    $('dl-doc').addEventListener('click', () => { download(outBytes, baseName() + '.' + ext, mime); toast('Downloaded.'); });
    $('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
      catch (_) { toast('Could not copy automatically — select the text.'); }
    });
    $('save').addEventListener('click', () => download(text, baseName() + '.txt', 'text/plain;charset=utf-8'));
    showView('result');
  }

  // ---- step 2: configure ---------------------------------------------------
  function renderConfig() {
    const a = state.analysis;
    // Strip PDF subset prefixes (6 uppercase letters + "+") and de-duplicate.
    const cleanFonts = [...new Set((a.fonts || []).map((f) => f.replace(/^[A-Z]{6}\+/, '')))];
    const fontChips = cleanFonts.map((f) => `<span class="chip">${esc(f)}</span>`).join('')
      || '<span class="chip">No embedded fonts detected</span>';

    $('view-config').innerHTML = `
      <div class="panel swap-enter">
        <div class="docrow">
          <div class="doc-ico">PDF</div>
          <div class="doc-meta">
            <h3>${esc(state.filename)}</h3>
            <div class="sub">${a.page_count} page${a.page_count === 1 ? '' : 's'} · ${cleanFonts.length} font${cleanFonts.length === 1 ? '' : 's'}</div>
          </div>
          <button class="linkbtn" onclick="App.reset()">Change file</button>
        </div>

        <div class="divline"></div>

        <div class="opts">
          <div>
            <div class="section-label">What would you like to do?</div>
            <div class="choice">
              <button class="tile ${state.mode === 'fix' ? 'on' : ''}" data-mode="fix">
                <span class="ti"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg></span>
                <div><h4>Fix the PDF</h4><p>Repair copy-paste, keep the file. Download a fixed PDF.</p></div>
              </button>
              <button class="tile ${state.mode === 'extract' ? 'on' : ''}" data-mode="extract">
                <span class="ti"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg></span>
                <div><h4>Extract text</h4><p>Pull clean Unicode text out of the PDF.</p></div>
              </button>
            </div>
          </div>

          <div id="extract-opts" ${state.mode === 'extract' ? '' : 'hidden'}>
            <div class="field-row">
              <div class="lab"><h4>Which pages?</h4><p>Useful for pecha-style books printed two-up.</p></div>
              <div class="seg" id="pages-seg">
                <button data-pages="all" class="on">All</button>
                <button data-pages="odd">Odd</button>
                <button data-pages="even">Even</button>
              </div>
            </div>
          </div>
        </div>

        <details class="fonts-reveal">
          <summary>${cleanFonts.length} font${cleanFonts.length === 1 ? '' : 's'} in this document</summary>
          <div class="chips">${fontChips}</div>
        </details>

        <div class="btn-actions">
          <button class="btn btn-primary" id="go">
            <span id="go-label">Fix &amp; download</span>
          </button>
        </div>
      </div>`;

    $('view-config').querySelectorAll('.tile').forEach((t) => t.addEventListener('click', () => {
      state.mode = t.dataset.mode;
      $('view-config').querySelectorAll('.tile').forEach((x) => x.classList.toggle('on', x === t));
      $('extract-opts').hidden = state.mode !== 'extract';
      $('go-label').textContent = state.mode === 'fix' ? 'Fix & download' : 'Extract text';
    }));
    const seg = $('pages-seg');
    if (seg) seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.pages = b.dataset.pages;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('go').addEventListener('click', submit);

    showView('config');
  }

  // ---- step 3: run (in the worker) -----------------------------------------
  // Run an operation on the already-loaded file (the worker keeps /in.pdf in its
  // FS, so fix and extract can be chained without re-uploading or re-booting).
  async function process() {
    prepProcessing();
    $('proc-title').textContent = state.mode === 'fix' ? 'Repairing your PDF…' : 'Extracting text…';
    $('proc-sub').textContent = 'Working on your document…';
    showView('processing');
    try {
      if (state.mode === 'fix') {
        const r = await call('fix');
        renderPdfResult(r.stats || {}, r.pdfBytes);
      } else {
        const r = await call('extract', { pages: state.pages || 'all' });
        renderTextResult(r);
      }
    } catch (err) { showError(err.message); }
  }

  function submit() {
    $('go').disabled = true;
    process();
  }

  // ---- step 4: results -----------------------------------------------------
  function renderPdfResult(s, pdfBytes) {
    const seen = s.fonts_seen || 0;
    const fixed = s.patched || 0;
    const noMatch = s.no_match ?? Math.max(0, seen - fixed - (s.no_change || 0));
    const tibetan = s.tibetan_chars || 0;
    const junk = s.junk_chars || 0;
    // junk = characters that still extract as non-Tibetan, non-ASCII after the
    // worker tried both the gid and PUA-free trees — the honest "does this copy
    // cleanly" signal. 0 = clean; >0 = some runs are still garbled. Issue #16
    // used to slip through as a false "all good" because we only counted real
    // Tibetan and never noticed the leftover garbage.
    const hasTibetan = tibetan >= 8;
    const phase =
      junk === 0 && fixed > 0  ? 'ok' :       // repaired and now clean
      junk === 0 && hasTibetan ? 'already' :  // was already valid Unicode
      hasTibetan               ? 'partial' :  // some Tibetan recovered, junk remains
                                 'cant';        // nothing usable came out
    const ok = phase === 'ok';

    const statCards = (
      phase === 'ok'      ? [['Fonts seen', seen], ['Fonts fixed', fixed], ['Glyphs upgraded', s.upgrades || 0]] :
      phase === 'already' ? [['Fonts seen', seen], ['Already Unicode', '✓']] :
      phase === 'partial' ? [['Fonts seen', seen], ['Fonts fixed', fixed], ['Still garbled', junk]] :
                            [['Fonts seen', seen], ['Fonts fixed', fixed], ['Not recognised', noMatch]]
    ).map(([label, val]) => `<div class="stat"><b>${val ?? 0}</b><span>${label}</span></div>`).join('');

    const badgeOk = `<div class="badge-ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></div>`;
    const badgeWarn = `<div class="badge-warn"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg></div>`;

    const head =
      phase === 'ok' ? `${badgeOk}
          <div><h3>Your PDF is fixed</h3><p>Copy-paste and text extraction should now return correct Unicode.</p></div>`
    : phase === 'already' ? `${badgeOk}
          <div><h3>This PDF is already fine</h3><p>Its Tibetan already extracts as correct Unicode — copy-paste and search work as-is, no repair needed. You can still extract the text below.</p></div>`
    : phase === 'partial' ? `${badgeWarn}
          <div><h3>Partially repaired</h3><p>Most of the Tibetan now copies as correct Unicode, but ${junk} character${junk === 1 ? '' : 's'} across some fonts still aren't recognised — those parts may copy as garbage. This file mixes legacy fonts we don't fully cover yet.</p></div>`
    : `${badgeWarn}
          <div><h3>This PDF couldn't be repaired</h3><p>None of its ${seen} fonts are in our recognition database, so its Tibetan can't be turned into Unicode. This file uses legacy fonts we don't cover yet.</p></div>`;

    const extractBtn = `<button class="btn btn-accent" id="to-extract"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg> Extract text</button>`;
    const dlBtn = `<button class="btn btn-primary" id="dl"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg> Download fixed PDF</button>`;
    // 'partial' / 'cant' files are exactly what a future "try harder" pass
    // (lazy-loaded gshape tree) would target; for now we invite the user to send
    // the file so coverage can be extended.
    const sendBtn = `<a class="btn btn-accent" href="mailto:eroux@bdrc.io?subject=${encodeURIComponent('Unsupported Tibetan PDF')}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="m22 7-10 6L2 7"/></svg> Send us this PDF</a>`;
    const doAnother = `<button class="btn btn-quiet" onclick="App.reset()" style="margin-left:auto">Do another</button>`;

    const actions =
      phase === 'ok'      ? `${dlBtn} ${extractBtn} ${doAnother}` :
      phase === 'already' ? `${extractBtn} ${doAnother}` :
      phase === 'partial' ? `${dlBtn} ${extractBtn} ${sendBtn} ${doAnother}` :
                            `${sendBtn}
          <button class="btn btn-quiet" onclick="App.reset()" style="margin-left:auto">Try another</button>`;

    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">${head}</div>
        <div class="stats">${statCards}</div>
        <div class="btn-actions" style="flex-wrap:wrap">${actions}</div>
      </div>`;
    if ($('dl')) {
      $('dl').addEventListener('click', () => {
        download(pdfBytes, baseName() + '.fixed.pdf', 'application/pdf');
        toast('Downloaded.');
      });
    }
    const extract = $('to-extract');
    if (extract) extract.addEventListener('click', () => { state.mode = 'extract'; process(); });
    showView('result');
  }

  function renderBlocks(blocks) {
    if (!blocks || !blocks.length) return '';
    // Fixed, script-aware sizing — stable whatever the page selection. Tibetan
    // reads smaller per-px than Latin, so it gets a larger scale; Latin/mixed is
    // kept modest so title-heavy pages don't blow up.
    const px = (s, tib) => tib
      ? Math.max(16, Math.min(34, s * 0.85))
      : Math.max(12, Math.min(28, s * 0.9));

    return blocks.map((b) => {
      const lines = (b.lines || []).map((line) => {
        const spans = line.map((run) => {
          const tib = run.tib != null ? run.tib : /[ༀ-࿿]/.test(run.t || '');
          const st = [];
          if (run.s) st.push(`font-size:${px(run.s, tib).toFixed(1)}px`);
          if (run.b) st.push('font-weight:700');
          if (run.i) st.push('font-style:italic');
          return `<span style="${st.join(';')}">${esc(run.t)}</span>`;
        }).join('');
        return `<div class="ln">${spans || '&nbsp;'}</div>`;
      }).join('');
      return `<div class="para">${lines}</div>`;
    }).join('');
  }

  function renderTextResult(r) {
    const text = r.text || '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const rich = renderBlocks(r.blocks);
    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">
          <div class="badge-ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></div>
          <div><h3>Text extracted</h3><p>${r.pages_used} of ${r.page_count} page${r.page_count === 1 ? '' : 's'} · formatting preserved</p></div>
        </div>
        <div class="texttools">
          <span class="fmt">${words.toLocaleString()} words</span>
        </div>
        <div class="textbox rich" id="textbox">${rich || '<span style="color:var(--ink-faint)">No extractable text on the selected pages.</span>'}</div>
        <div class="btn-actions" style="flex-wrap:wrap">
          <button class="btn btn-primary" id="copy"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>
          <button class="btn btn-ghost" id="save"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg> .txt</button>
          <button class="btn btn-ghost" id="save-docx"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg> .docx</button>
          <button class="btn btn-accent" id="to-fix"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg> Fix the PDF</button>
          <button class="btn btn-quiet" onclick="App.reset()" style="margin-left:auto">Do another</button>
        </div>
      </div>`;
    $('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
      catch (_) { toast('Could not copy automatically — select the text.'); }
    });
    $('save').addEventListener('click', () => {
      download(text, baseName() + '.txt', 'text/plain;charset=utf-8');
    });
    $('save-docx').addEventListener('click', () => {
      download(r.docxBytes, baseName() + '.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });
    $('to-fix').addEventListener('click', () => { state.mode = 'fix'; process(); });
    showView('result');
  }

  // ---- scanned / image PDF -------------------------------------------------
  // We repair how Tibetan is *encoded*, not pictures of text. A PDF with no
  // extractable text can only come back empty, so explain that up front rather
  // than letting the user pick fix/extract and get nothing back.
  function renderScannedNotice(a) {
    const scanned = !!a.has_images;
    const single = a.page_count === 1;
    const pages = single ? 'single page' : `${a.page_count} pages`;
    const title = scanned ? 'This looks like a scanned PDF' : 'No text found in this PDF';
    const body = scanned
      ? `Its ${pages} ${single ? 'is an image' : 'are images'}, so there's no text to fix or extract. This tool repairs how Tibetan text is <em>encoded</em> — it doesn't do OCR (turning pictures of text into characters).`
      : `There's no extractable text on its ${pages}, so there's nothing to fix or extract.`;
    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">
          <div class="badge-warn"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg></div>
          <div><h3>${title}</h3><p>${body}</p></div>
        </div>
        <div class="btn-actions">
          <button class="btn btn-primary" onclick="App.reset()">Try another file</button>
        </div>
      </div>`;
    showView('result');
  }

  // ---- errors / reset ------------------------------------------------------
  function showError(msg) {
    $('err-msg').textContent = msg || 'Unexpected error.';
    showView('error');
  }

  function reset() {
    state = {};
    $('file').value = '';
    showView('upload');
  }

  return { init, reset };
})();

document.addEventListener('DOMContentLoaded', App.init);
