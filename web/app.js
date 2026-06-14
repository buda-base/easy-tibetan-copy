/* Pecha — Tibetan PDF Fix : front-end state machine */
const App = (() => {
  const views = ['upload', 'config', 'processing', 'result', 'error'];
  const $ = (id) => document.getElementById(id);
  const cfg = { maxUploadMb: 5, maxQueue: 50 };

  let state = {};
  let pollTimer = null;

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

  async function api(url, opts) {
    const res = await fetch(url, opts);
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) {
      const detail = (body && body.detail) || `Request failed (${res.status})`;
      throw new Error(detail);
    }
    return body;
  }

  // ---- init ----------------------------------------------------------------
  async function init() {
    try {
      const c = await api('/api/config');
      cfg.maxUploadMb = c.max_upload_mb; cfg.maxQueue = c.max_queue;
      $('limit-pill').textContent = `PDF · up to ${c.max_upload_mb} MB`;
    } catch (_) { /* defaults are fine */ }
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
    // also allow paste of a file
    window.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData?.files || [])][0]; if (f) handleFile(f);
    });
  }

  // ---- step 1: analyze -----------------------------------------------------
  async function handleFile(file) {
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      return toast('Please choose a PDF file.');
    }
    if (file.size > cfg.maxUploadMb * 1024 * 1024) {
      return toast(`That file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${cfg.maxUploadMb} MB.`);
    }
    $('proc-title').textContent = 'Reading your document…';
    $('proc-sub').textContent = 'Inspecting fonts and pages.';
    $('proc-queue').hidden = true;
    showView('processing');
    try {
      const fd = new FormData(); fd.append('file', file);
      const data = await api('/api/analyze', { method: 'POST', body: fd });
      state = {
        token: data.token,
        filename: data.filename || file.name,
        analysis: data.analysis,
        mode: 'fix',
        pages: 'all',
      };
      renderConfig();
    } catch (err) { showError(err.message); }
  }

  // ---- step 2: configure ---------------------------------------------------
  function renderConfig() {
    const a = state.analysis;

    const fontChips = (a.fonts || []).map((f) => {
      return `<span class="chip">${esc(f.name)}</span>`;
    }).join('') || '<span class="chip">No embedded fonts detected</span>';

    $('view-config').innerHTML = `
      <div class="panel swap-enter">
        <div class="docrow">
          <div class="doc-ico">PDF</div>
          <div class="doc-meta">
            <h3>${esc(state.filename)}</h3>
            <div class="sub">${a.page_count} page${a.page_count === 1 ? '' : 's'} · ${(a.fonts || []).length} font${(a.fonts || []).length === 1 ? '' : 's'}</div>
          </div>
          <button class="linkbtn" onclick="App.reset()">Change file</button>
        </div>

        <div class="divline"></div>

        <div class="section-label">Fonts in this document</div>
        <div class="chips">${fontChips}</div>

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
                <div><h4>Extract text</h4><p>Pull clean, structured text out of the PDF.</p></div>
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

        <div class="btn-actions">
          <button class="btn btn-primary" id="go">
            <span id="go-label">Fix &amp; download</span>
          </button>
        </div>
      </div>`;

    // wire controls
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

  // ---- step 3: submit + poll ----------------------------------------------
  async function submit() {
    $('go').disabled = true;
    $('proc-title').textContent = state.mode === 'fix' ? 'Repairing your PDF…' : 'Extracting text…';
    $('proc-sub').textContent = 'This usually takes a few seconds.';
    $('proc-queue').hidden = true;
    showView('processing');
    try {
      const job = await api('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.token, mode: state.mode, pages: state.pages }),
      });
      state.jobId = job.job_id;
      reflect(job);
      poll();
    } catch (err) { showError(err.message); }
  }

  function reflect(job) {
    if (job.status === 'queued') {
      const pos = job.position || 0;
      const q = $('proc-queue');
      q.hidden = false;
      q.className = 'qpos';
      q.innerHTML = pos <= 0
        ? `<span>You're next in line…</span>`
        : `<b>${pos}</b><span>ahead of you in the queue</span>`;
      $('proc-title').textContent = 'Waiting in the queue';
      $('proc-sub').textContent = 'One document is processed at a time.';
    } else if (job.status === 'processing') {
      $('proc-queue').hidden = true;
      $('proc-title').textContent = state.mode === 'fix' ? 'Repairing your PDF…' : 'Extracting text…';
      $('proc-sub').textContent = 'Almost there.';
    }
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const job = await api('/api/jobs/' + state.jobId);
        if (job.status === 'done') return renderResult(job);
        if (job.status === 'error') return showError(job.error || 'Processing failed.');
        reflect(job);
        poll();
      } catch (err) { showError(err.message); }
    }, 750);
  }

  // ---- step 4: result ------------------------------------------------------
  function renderResult(job) {
    if (job.result_kind === 'pdf') return renderPdfResult(job);
    return renderTextResult(job);
  }

  function renderPdfResult(job) {
    const s = job.stats || {};
    const statCards = [
      ['Fonts seen', s.fonts_seen],
      ['Fonts fixed', (s.patched || 0) + (s.upgrades || 0)],
      ['Already OK', s.no_change],
    ].map(([label, val]) => `<div class="stat"><b>${val ?? 0}</b><span>${label}</span></div>`).join('');

    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">
          <div class="badge-ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></div>
          <div><h3>Your PDF is fixed</h3><p>Copy-paste and text extraction should now return correct Unicode.</p></div>
        </div>
        <div class="stats">${statCards}</div>
        <div class="btn-actions">
          <button class="btn btn-primary" id="dl"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg> Download fixed PDF</button>
          <button class="btn btn-ghost" onclick="App.reset()">Do another</button>
        </div>
      </div>`;
    $('dl').addEventListener('click', () => {
      window.location.href = job.download_url;
      const b = $('dl');
      setTimeout(() => { b.innerHTML = 'Downloaded ✓'; toast('Downloaded. The file is now wiped from the server.'); }, 400);
    });
    showView('result');
  }

  function renderTextResult(job) {
    const text = job.text || '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    $('view-result').innerHTML = `
      <div class="panel swap-enter">
        <div class="result-head">
          <div class="badge-ok"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></div>
          <div><h3>Text extracted</h3><p>${job.pages_used} of ${job.page_count} page${job.page_count === 1 ? '' : 's'} · Markdown</p></div>
        </div>
        <div class="texttools">
          <span class="fmt">${esc((job.format || 'text'))} · ${words.toLocaleString()} words</span>
          <div style="display:flex;gap:10px">
            <button class="linkbtn" id="copy">Copy</button>
            <button class="linkbtn" id="save">${job.format === 'markdown' ? '.md' : '.txt'}</button>
            ${job.docx_download_url ? '<button class="linkbtn" id="save-docx">Word (.docx)</button>' : ''}
          </div>
        </div>
        <div class="textbox" id="textbox">${esc(text) || '<span style="color:var(--ink-faint)">No extractable text on the selected pages.</span>'}</div>
        <div class="btn-actions">
          <button class="btn btn-ghost" onclick="App.reset()" style="margin-left:auto">Do another</button>
        </div>
      </div>`;
    $('copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
      catch (_) { toast('Could not copy automatically — select the text.'); }
    });
    $('save').addEventListener('click', () => {
      const ext = job.format === 'markdown' ? 'md' : 'txt';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = (state.filename || 'document').replace(/\.pdf$/i, '') + '.' + ext;
      a.click(); URL.revokeObjectURL(url);
    });
    if (job.docx_download_url) {
      const docxBtn = $('save-docx');
      docxBtn.addEventListener('click', () => {
        // Server streams the .docx then evicts the job; disable to avoid a 2nd 404.
        docxBtn.disabled = true;
        window.location.href = job.docx_download_url;
      });
    }
    showView('result');
  }

  // ---- errors / reset ------------------------------------------------------
  function showError(msg) {
    clearTimeout(pollTimer);
    $('err-msg').textContent = msg || 'Unexpected error.';
    showView('error');
  }

  function reset() {
    clearTimeout(pollTimer);
    state = {};
    $('file').value = '';
    showView('upload');
  }

  return { init, reset };
})();

document.addEventListener('DOMContentLoaded', App.init);
