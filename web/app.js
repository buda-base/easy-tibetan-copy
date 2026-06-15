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
    worker = new Worker('worker.js');
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
  async function handleFile(file) {
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))
      return toast('Please choose a PDF file.');

    state = { filename: file.name, mode: 'fix', pages: 'all' };

    const mb = file.size / 1048576;
    if (mb > WARN_MB && !file._confirmed) return renderSizeWarning(file, mb);

    $('proc-title').textContent = 'Reading your document…';
    $('proc-sub').textContent = 'Warming up the engine…';
    showView('processing');
    try {
      const buf = await file.arrayBuffer();
      // Transfer the buffer to the worker; it keeps /in.pdf in its FS for fix/extract.
      const a = await call('analyze', { bytes: buf }, [buf]);
      state.analysis = a;
      renderConfig();
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
    const statCards = [
      ['Fonts seen', s.fonts_seen],
      ['Fonts fixed', s.patched],
      ['Glyphs upgraded', s.upgrades],
    ].map(([label, val]) => `<div class="stat"><b>${val ?? 0}</b><span>${label}</span></div>`).join('');

    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">
          <div class="badge-ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></div>
          <div><h3>Your PDF is fixed</h3><p>Copy-paste and text extraction should now return correct Unicode.</p></div>
        </div>
        <div class="stats">${statCards}</div>
        <div class="btn-actions" style="flex-wrap:wrap">
          <button class="btn btn-primary" id="dl"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg> Download fixed PDF</button>
          <button class="btn btn-ghost" id="to-extract"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg> Extract text</button>
          <button class="btn btn-ghost" onclick="App.reset()" style="margin-left:auto">Do another</button>
        </div>
      </div>`;
    $('dl').addEventListener('click', () => {
      download(pdfBytes, baseName() + '.fixed.pdf', 'application/pdf');
      toast('Downloaded.');
    });
    $('to-extract').addEventListener('click', () => { state.mode = 'extract'; process(); });
    showView('result');
  }

  function renderBlocks(blocks) {
    if (!blocks || !blocks.length) return '';
    // Normalise PDF point-sizes to readable on-screen px: map the dominant size
    // (the one carrying the most text — i.e. the body) to ~18px, keeping relative
    // proportions so headings stay bigger. Absolute PDF sizes are often huge.
    const charsBySize = {};
    for (const b of blocks) for (const ln of b.lines) for (const r of ln) {
      if (r.s) charsBySize[r.s] = (charsBySize[r.s] || 0) + (r.t ? r.t.length : 0);
    }
    let body = 0, best = -1;
    for (const s in charsBySize) if (charsBySize[s] > best) { best = charsBySize[s]; body = parseFloat(s); }
    const scale = body ? 18 / body : 1;
    const px = (s) => Math.max(12, Math.min(40, s * scale));

    return blocks.map((b) => {
      const lines = (b.lines || []).map((line) => {
        const spans = line.map((run) => {
          const st = [];
          if (run.s) st.push(`font-size:${px(run.s).toFixed(1)}px`);
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
          <button class="btn btn-ghost" id="copy"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>
          <button class="btn btn-ghost" id="save"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg> .txt</button>
          <button class="btn btn-ghost" id="save-docx"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg> .docx</button>
          <button class="btn btn-ghost" id="to-fix" style="margin-left:auto"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg> Fix the PDF</button>
          <button class="btn btn-ghost" onclick="App.reset()">Do another</button>
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
