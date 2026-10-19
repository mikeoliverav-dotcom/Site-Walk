'use strict';
/* Site Walk — offline site survey app.
   Everything is stored on the device in IndexedDB. No server, no account. */

const APP_VERSION = '1.7.3';
/* Report header/footer text. Set `site` to a web address to show it in the footer. */
const BRAND = { name: 'Site Walk', tagline: 'Survey report', site: '' };

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
};
function fmtDate(iso, withTime = true) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], withTime
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}
function toast(msg, ms = 2800) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function storageMsg(e) {
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || '')))
    return 'This phone is out of room for the app. Share and delete an old survey to free space.';
  return 'Could not save: ' + (e && e.message ? e.message : e);
}
function twoTap(btn, label, confirmLabel, action) {
  btn.textContent = label;
  btn.onclick = async () => {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm'); btn.textContent = confirmLabel;
      clearTimeout(btn._t); btn._t = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = label; }, 5000);
      return;
    }
    clearTimeout(btn._t); btn.classList.remove('confirm'); btn.textContent = label;
    await action();
  };
}
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That image could not be read')); i.src = src; });
}
/* Downscale + re-encode a picked image. <img> decoding applies the photo's EXIF rotation. */
async function shrink(file, max = 2048, q = 0.82) {
  const u = URL.createObjectURL(file);
  try {
    const im = await loadImg(u);
    let s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const px = im.naturalWidth * im.naturalHeight * s * s;
    if (px > 16e6) s *= Math.sqrt(16e6 / px);
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(im, 0, 0, c.width, c.height);
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    if (!b) throw new Error('That image could not be processed');
    return { blob: b, w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(u); }
}

/* ---------------- storage (IndexedDB) ---------------- */
let dbp = null;
function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('sitewalk', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('surveys')) d.createObjectStore('surveys', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('stops')) d.createObjectStore('stops', { keyPath: 'id' }).createIndex('surveyId', 'surveyId');
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function done(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function os(name, mode = 'readonly') {
  const d = await openDB(); const t = d.transaction(name, mode);
  const s = t.objectStore(name);
  if (mode === 'readwrite') s._done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Save was interrupted')); });
  return s;
}
const idb = {
  async get(s, k) { return done((await os(s)).get(k)); },
  async all(s) { return done((await os(s)).getAll()); },
  async byIndex(s, i, v) { return done((await os(s)).index(i).getAll(v)); },
  async put(s, v) { const st = await os(s, 'readwrite'); st.put(v); await st._done; },
  async del(s, k) { const st = await os(s, 'readwrite'); st.delete(k); await st._done; }
};
/* Blobs are stored as ArrayBuffer + type (most reliable across iOS versions). */
async function putBlob(blob) {
  const id = uid();
  await idb.put('blobs', { id, type: blob.type || 'image/jpeg', buf: await blob.arrayBuffer() });
  return id;
}
async function getBlob(id) { const r = await idb.get('blobs', id); return r ? new Blob([r.buf], { type: r.type }) : null; }
const urlCache = new Map();
async function blobURL(id) {
  if (!id) return '';
  if (urlCache.has(id)) return urlCache.get(id);
  const b = await getBlob(id); if (!b) return '';
  const u = URL.createObjectURL(b); urlCache.set(id, u); return u;
}
function dropURL(id) { const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); } }
function clearURLs() { for (const u of urlCache.values()) URL.revokeObjectURL(u); urlCache.clear(); }
function hydrate(root) {
  root.querySelectorAll('img[data-blob]').forEach(img => blobURL(img.dataset.blob).then(u => { if (u) img.src = u; }));
}

/* ---------------- state ---------------- */
const S = { surveys: [], cur: null, stops: [], selId: null, armed: false, zoom: 1, lastZone: '' };
const sel = () => S.stops.find(p => p.id === S.selId);
function show(view) { $('listView').hidden = view !== 'list'; $('surveyView').hidden = view !== 'survey'; window.scrollTo(0, 0); }
async function touch() { if (!S.cur) return; S.cur.updatedAt = new Date().toISOString(); try { await idb.put('surveys', { ...S.cur }); } catch (e) { toast(storageMsg(e)); } }

/* ---------------- survey list ---------------- */
async function renderList() {
  S.surveys = (await idb.all('surveys')).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const L = $('surveyList');
  if (!S.surveys.length) {
    L.innerHTML = `<div class="emptycard"><h3>No surveys yet</h3><p>Tap <b>New survey</b>, load the site plan, then drop a pin at each stop on your walk. Photos and notes save on this phone as you go, with or without a signal. When you're done, build the PDF report and share it with the team.</p></div>`;
  } else {
    const allStops = await idb.all('stops');
    L.innerHTML = S.surveys.map(s => {
      const st = allStops.filter(p => p.surveyId === s.id);
      const ph = st.reduce((a, p) => a + (p.photos?.length || 0), 0);
      const iss = st.filter(p => p.issue).length;
      return `<button class="scard" data-id="${s.id}">
        <span class="sname">${esc(s.name || 'Untitled survey')}</span>
        <span class="smeta">${esc(fmtDate(s.createdAt, false))}${s.surveyor ? ' · ' + esc(s.surveyor) : ''}</span>
        <span class="scount"><b>${st.length}</b> stops · <b>${ph}</b> photos${iss ? ` · <b style="color:var(--issue)">${iss}</b> issue${iss === 1 ? '' : 's'}` : ''}${s.mapId ? '' : ' · no plan'}</span></button>`;
    }).join('');
    L.querySelectorAll('.scard').forEach(b => (b.onclick = () => openSurvey(b.dataset.id)));
  }
  renderStorage();
}
async function renderStorage() {
  try {
    if (!navigator.storage?.estimate) return;
    const e = await navigator.storage.estimate();
    const mb = (e.usage || 0) / 1048576;
    $('storageInfo').textContent = `Using ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB on this phone · v${APP_VERSION}`;
  } catch (_) {}
}
$('newBtn').onclick = () => {
  const f = $('newForm'); f.hidden = !f.hidden;
  if (!f.hidden) { $('nsSurveyor').value = ls.get('surveyor', ''); $('nsName').focus(); }
};
$('nsCancel').onclick = () => ($('newForm').hidden = true);
$('newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('nsName').value.trim() || 'Untitled survey';
  const surveyor = $('nsSurveyor').value.trim(); ls.set('surveyor', surveyor);
  const now = new Date().toISOString();
  const noMap = $('nsModeNoPlan').checked;
  const s = { id: uid(), name, surveyor, createdAt: now, updatedAt: now, mapId: null, mapW: 0, mapH: 0, sheets: [], sheetId: null, noMap, gps: true };
  try { await idb.put('surveys', s); } catch (err) { return toast(storageMsg(err)); }
  $('newForm').hidden = true; $('nsName').value = ''; $('nsModePlan').checked = true;
  openSurvey(s.id);
});

/* ---------------- survey view ---------------- */
async function openSurvey(id) {
  clearURLs();
  S.cur = await idb.get('surveys', id);
  if (!S.cur) { toast('That survey could not be found'); return showList(); }
  S.stops = (await idb.byIndex('stops', 'surveyId', id)).sort((a, b) => a.n - b.n);
  S.selId = null; S.armed = false; S.zoom = 1;
  const z = [...S.stops].reverse().find(p => p.zone); S.lastZone = z ? z.zone : '';
  migrateSheets();
  $('mapPanel').dataset.mode = ''; $('settings').open = false; S.fileMode = 'add'; S.sheetKey = '';
  show('survey'); renderSurvey(true);
}
/* ---- plan sheets: a survey can hold several plan sheets; each pin belongs to one ---- */
function curSheet() { const s = S.cur; return s?.sheets?.find(x => x.id === s.sheetId) || null; }
function sheetById(id) { return S.cur?.sheets?.find(x => x.id === id) || null; }
function syncSheet() { const sh = curSheet(); S.cur.mapId = sh ? sh.mapId : null; S.cur.mapW = sh?.w || 0; S.cur.mapH = sh?.h || 0; }
function migrateSheets() {
  const s = S.cur; let changed = false;
  if (!Array.isArray(s.sheets)) {
    s.sheets = s.mapId ? [{ id: uid(), name: 'Sheet 1', mapId: s.mapId, w: s.mapW || 0, h: s.mapH || 0 }] : [];
    s.sheetId = s.sheets[0]?.id || null; changed = true;
  }
  if (s.sheets.length && !sheetById(s.sheetId)) { s.sheetId = s.sheets[0].id; changed = true; }
  syncSheet();
  const first = s.sheets[0]?.id;
  for (const p of S.stops) if (p.x != null && !p.sheetId && first) { p.sheetId = first; idb.put('stops', JSON.parse(JSON.stringify(p))).catch(() => {}); }
  if (changed) touch();
}
function switchSheet(id) {
  if (!S.cur || S.cur.sheetId === id || !sheetById(id)) return;
  S.cur.sheetId = id; syncSheet(); S.zoom = 1; touch(); renderSurvey();
  const sc = $('mapScroll'); if (sc) { sc.scrollLeft = 0; sc.scrollTop = 0; }
}

async function showList() { flushSaves(); closeSheet(); clearURLs(); S.cur = null; $('surveyView').classList.remove('split'); document.body.classList.remove('split-on'); show('list'); renderList(); }
$('backBtn').onclick = showList;

function renderSurvey(full) {
  const s = S.cur; if (!s) return;
  if (full || document.activeElement !== $('svName')) $('svName').value = s.name || '';
  $('cStops').textContent = S.stops.length;
  $('cPhotos').textContent = S.stops.reduce((a, p) => a + (p.photos?.length || 0), 0);
  $('svSurveyor').textContent = s.surveyor ? 'Surveyor: ' + s.surveyor : '';
  renderIssueCount();
  const hasMap = !!s.mapId;
  $('actionBar').hidden = !hasMap && !s.noMap;
  $('surveyView').classList.toggle('split', hasMap);
  document.body.classList.toggle('split-on', hasMap);
  $('addBtn').textContent = hasMap ? (S.armed ? 'Tap the plan… (cancel)' : '+ Drop pin') : '+ New stop';
  $('addBtn').classList.toggle('armed', S.armed);
  $('addBtn').classList.toggle('primary', !S.armed);
  $('reportBtn').disabled = !S.stops.length;
  renderMap(); renderStops(); renderSettings(full);
  if (S.selId) renderSheet(false);
}

let nameT;
$('svName').addEventListener('input', () => {
  clearTimeout(nameT);
  nameT = setTimeout(() => { if (S.cur) { S.cur.name = $('svName').value.trim(); touch(); } }, 500);
});

function renderMap() {
  const s = S.cur, P = $('mapPanel');
  if (!s.mapId) {
    if (P.dataset.mode === 'pick' || P.dataset.mode === 'busy') return;
    if (s.noMap) { P.hidden = true; return; }
    P.hidden = false;
    if (P.dataset.mode !== 'empty') {
      P.dataset.mode = 'empty';
      P.innerHTML = `<div class="empty"><h2>Load the site plan</h2>
        <ol><li>Pick the plan as a PDF or an image. For a multi-page PDF, choose every sheet your walk covers. You can add more sheets later.</li>
        <li>Tap <b>Drop pin</b>, then tap where you're standing.</li>
        <li>Take photos and add notes for that spot. Everything saves on this phone.</li></ol>
        <div class="row"><button class="btn primary" id="upMap">Load plan (PDF or image)</button><button class="btn" id="noMap">Walk without a plan</button></div></div>`;
      $('upMap').onclick = () => { S.fileMode = 'add'; $('mapFile').click(); };
      $('noMap').onclick = async () => { s.noMap = true; await touch(); renderSurvey(); };
    }
    return;
  }
  P.hidden = false;
  if (P.dataset.mode !== 'map') {
    P.dataset.mode = 'map';
    P.innerHTML = `<div class="sheetbar" id="sheetBar"></div><div class="mapbar"><span class="hint" id="mapHint"></span>
        <span class="zoom"><button id="zOut" aria-label="Zoom out">−</button><span id="zLbl">1×</span><button id="zIn" aria-label="Zoom in">+</button></span></div>
      <div class="mapscroll" id="mapScroll"><div class="mapinner" id="mapInner"><img id="mapImg" alt="Site plan"></div></div>`;
    $('zIn').onclick = () => setZoom(S.zoom * 1.5);
    $('zOut').onclick = () => setZoom(S.zoom / 1.5);
    $('mapInner').addEventListener('click', onMapTap);
    attachPinch($('mapScroll'));
  }
  blobURL(s.mapId).then(u => { const im = $('mapImg'); if (im && u && im.getAttribute('src') !== u) im.src = u; });
  const sb = $('sheetBar');
  sb.innerHTML = s.sheets.map(sh => {
    const n = S.stops.filter(p => p.sheetId === sh.id && p.x != null).length;
    return `<button class="stab${sh.id === s.sheetId ? ' on' : ''}" data-id="${sh.id}">${esc(sh.name)}<span>${n}</span></button>`;
  }).join('') + `<button class="stab add" id="addSheetBtn">+ Sheet</button>`;
  sb.querySelectorAll('.stab[data-id]').forEach(b => (b.onclick = () => switchSheet(b.dataset.id)));
  $('addSheetBtn').onclick = () => { S.fileMode = 'add'; $('mapFile').click(); };
  sb.querySelector('.stab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const inner = $('mapInner');
  inner.style.width = (S.zoom * 100) + '%';
  inner.classList.toggle('armed', S.armed);
  $('zLbl').textContent = (Math.round(S.zoom * 10) / 10) + '×';
  const h = $('mapHint');
  h.textContent = S.armed ? 'Tap the plan where you are standing.' : 'Pins mark each stop. Tap a pin to open it.';
  h.classList.toggle('live', S.armed);
  inner.querySelectorAll('.pin').forEach(n => n.remove());
  for (const p of S.stops) {
    if (p.x == null || p.sheetId !== s.sheetId) continue;
    const b = document.createElement('button');
    b.className = 'pin' + (p.issue ? ' issue' : '') + (p.id === S.selId ? ' sel' : '');
    b.style.left = (p.x * 100) + '%'; b.style.top = (p.y * 100) + '%';
    b.setAttribute('aria-label', 'Stop ' + p.n + (p.issue ? ' (issue)' : ''));
    b.innerHTML = `<span>${p.n}</span><i></i>`;
    b.onclick = (e) => { e.stopPropagation(); if (!S.armed && !justPinched()) openStop(p.id); };
    inner.appendChild(b);
  }
}
const ZMIN = 1, ZMAX = 8;
function applyZoom(z) {
  S.zoom = Math.max(ZMIN, Math.min(ZMAX, z));
  const inner = $('mapInner'); if (inner) inner.style.width = (S.zoom * 100) + '%';
  const l = $('zLbl'); if (l) l.textContent = (Math.round(S.zoom * 10) / 10) + '×';
}
/* Zoom around a point (client coords); defaults to the centre of the plan window. */
function zoomAt(z, px, py) {
  const sc = $('mapScroll'); if (!sc) return;
  const r = sc.getBoundingClientRect();
  const ox = (px ?? r.left + sc.clientWidth / 2) - r.left, oy = (py ?? r.top + sc.clientHeight / 2) - r.top;
  const cx = (sc.scrollLeft + ox) / sc.scrollWidth, cy = (sc.scrollTop + oy) / sc.scrollHeight;
  applyZoom(z);
  sc.scrollLeft = cx * sc.scrollWidth - ox;
  sc.scrollTop = cy * sc.scrollHeight - oy;
}
function setZoom(z) { zoomAt(z); }
/* Two-finger pinch inside the plan window (one finger still scrolls natively). Ctrl/trackpad pinch on desktop too. */
function attachPinch(sc) {
  let st = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  sc.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const r = sc.getBoundingClientRect(), m = mid(e.touches);
    st = { d: dist(e.touches) || 1, z: S.zoom, cx: (sc.scrollLeft + m.x - r.left) / sc.scrollWidth, cy: (sc.scrollTop + m.y - r.top) / sc.scrollHeight };
  }, { passive: false });
  sc.addEventListener('touchmove', e => {
    if (!st || e.touches.length !== 2) return;
    e.preventDefault();
    const r = sc.getBoundingClientRect(), m = mid(e.touches);
    applyZoom(st.z * dist(e.touches) / st.d);
    sc.scrollLeft = st.cx * sc.scrollWidth - (m.x - r.left);
    sc.scrollTop = st.cy * sc.scrollHeight - (m.y - r.top);
  }, { passive: false });
  const end = e => { if (st && e.touches.length < 2) { st = null; S.pinchUntil = Date.now() + 400; } };
  sc.addEventListener('touchend', end); sc.addEventListener('touchcancel', end);
  sc.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); zoomAt(S.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY); }, { passive: false });
}
const justPinched = () => Date.now() < (S.pinchUntil || 0);
/* Stop Safari zooming the whole page */
['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
function onMapTap(e) {
  if (!S.armed || justPinched()) return;
  const r = $('mapInner').getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  S.armed = false;
  createStop(+x.toFixed(4), +y.toFixed(4));
}
$('addBtn').onclick = () => {
  if (S.cur.mapId) {
    S.armed = !S.armed; renderSurvey();
    if (S.armed) backToPlan();
  } else { $('addBtn').disabled = true; createStop(null, null).finally(() => { $('addBtn').disabled = false; }); }
};

function renderStops() {
  const L = $('stopList');
  if (!S.stops.length) {
    L.innerHTML = `<div class="listempty">No stops yet. ${S.cur.mapId ? 'Tap <b>Drop pin</b>, then tap your spot on the plan.' : (S.cur.noMap ? 'Tap <b>New stop</b> each time you reach a new location.' : 'Load the plan above, or walk without one.')}</div>`;
    return;
  }
  L.innerHTML = S.stops.map(p => {
    const ph = p.photos || [];
    return `<button class="stop${p.issue ? ' issue' : ''}${p.id === S.selId ? ' sel' : ''}" data-id="${p.id}"><span class="num">${p.n}</span><span class="body">
      <span class="zone ${p.zone ? '' : 'none'}">${esc(p.zone || 'No location named')}${p.issue ? '<span class="tag issue">Issue</span>' : ''}</span>
      ${p.note ? `<span class="note">${esc(p.note)}</span>` : ''}
      ${ph.length ? `<span class="thumbs">${ph.slice(0, 8).map(id => `<img data-blob="${id}" alt="">`).join('')}</span>` : ''}
      <span class="sf"><span>${esc(fmtDate(p.createdAt))}</span><span>${ph.length} photo${ph.length === 1 ? '' : 's'}</span>${p.x == null && S.cur.mapId ? '<span>no pin</span>' : ''}${S.cur.sheets.length > 1 && sheetById(p.sheetId) ? `<span>${esc(sheetById(p.sheetId).name)}</span>` : ''}</span>
    </span></button>`;
  }).join('');
  L.querySelectorAll('.stop').forEach(b => (b.onclick = () => openStop(b.dataset.id)));
  hydrate(L);
}

/* ---------------- settings ---------------- */
function renderSettings(full) {
  const s = S.cur;
  if (full || document.activeElement !== $('setSurveyor')) $('setSurveyor').value = s.surveyor || '';
  $('setGps').checked = s.gps !== false;
  $('replaceMap').textContent = s.mapId ? 'Replace this sheet' : 'Load plan';
  $('replaceHint').hidden = !(s.mapId && S.stops.some(p => p.x != null && p.sheetId === s.sheetId));
  renderSheetSettings(full);
}
function renderSheetSettings(full) {
  const box = $('sheetSettings'), s = S.cur;
  box.hidden = !s.sheets.length;
  const key = s.sheets.map(sh => sh.id + ':' + S.stops.filter(p => p.sheetId === sh.id && p.x != null).length).join('|');
  if (!full && key === S.sheetKey && box.contains(document.activeElement)) return;
  if (!full && key === S.sheetKey) return;
  S.sheetKey = key;
  box.innerHTML = `<span class="fl">Plan sheets</span>` + s.sheets.map(sh => {
    const n = S.stops.filter(p => p.sheetId === sh.id && p.x != null).length;
    return `<div class="shrow"><input class="field" data-id="${sh.id}" value="${esc(sh.name)}" maxlength="40" aria-label="Sheet name">
      <span class="sub">${n} pin${n === 1 ? '' : 's'}</span>
      ${n ? '' : `<button class="btn danger" data-del="${sh.id}">Remove</button>`}</div>`;
  }).join('') + `<div class="row"><button class="btn" id="setAddSheet">+ Add sheet</button></div>`;
  box.querySelectorAll('input[data-id]').forEach(inp => {
    let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(() => { const sh = sheetById(inp.dataset.id); if (!sh) return; sh.name = inp.value.trim() || 'Sheet'; touch(); renderMap(); renderStops(); }, 400); };
  });
  box.querySelectorAll('button[data-del]').forEach(b => twoTap(b, 'Remove', 'Tap again', async () => {
    const id = b.dataset.del, sh = sheetById(id); if (!sh) return;
    s.sheets = s.sheets.filter(x => x.id !== id);
    if (s.sheetId === id) s.sheetId = s.sheets[0]?.id || null;
    syncSheet(); await touch();
    try { await idb.del('blobs', sh.mapId); } catch (_) {} dropURL(sh.mapId);
    $('mapPanel').dataset.mode = ''; S.sheetKey = ''; renderSurvey(true); toast('Sheet removed');
  }));
  $('setAddSheet').onclick = () => { S.fileMode = 'add'; $('mapFile').click(); };
}
let survT;
$('setSurveyor').addEventListener('input', () => {
  clearTimeout(survT);
  survT = setTimeout(() => { S.cur.surveyor = $('setSurveyor').value.trim(); ls.set('surveyor', S.cur.surveyor); touch(); $('svSurveyor').textContent = S.cur.surveyor ? 'Surveyor: ' + S.cur.surveyor : ''; }, 500);
});
$('setGps').onchange = () => { S.cur.gps = $('setGps').checked; touch(); };
$('replaceMap').onclick = () => { S.fileMode = S.cur.mapId ? 'replace' : 'add'; $('mapFile').click(); };
twoTap($('delSurvey'), 'Delete survey', 'Tap again to delete for good', async () => {
  const s = S.cur; if (!s) return;
  try {
    for (const p of S.stops) {
      for (const id of (p.photos || [])) await idb.del('blobs', id);
      await idb.del('stops', p.id);
    }
    for (const sh of (s.sheets || [])) await idb.del('blobs', sh.mapId);
    if (s.mapId && !(s.sheets || []).some(sh => sh.mapId === s.mapId)) await idb.del('blobs', s.mapId);
    await idb.del('surveys', s.id);
    toast('Survey deleted');
    showList();
  } catch (e) { toast('Could not delete: ' + (e.message || e)); }
});

/* ---------------- stops ---------------- */
async function createStop(x, y) {
  const n = S.stops.reduce((m, p) => Math.max(m, p.n || 0), 0) + 1;
  const st = { id: uid(), surveyId: S.cur.id, n, x, y, sheetId: x != null ? S.cur.sheetId : null, zone: '', note: '', photos: [], issue: false, createdAt: new Date().toISOString(), gps: null };
  try { await idb.put('stops', st); } catch (e) { renderSurvey(); return toast(storageMsg(e)); }
  S.stops.push(st); await touch();
  S.selId = st.id; renderSurvey(); openSheet();
  $('sZone').focus();
  if (S.cur.gps !== false && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async pos => {
      const cur = S.stops.find(p => p.id === st.id); if (!cur) return;
      cur.gps = { lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6), acc: Math.round(pos.coords.accuracy) };
      await saveStop(cur);
      if (S.selId === cur.id) renderGps(cur);
    }, () => {}, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  }
}
async function saveStop(st) {
  try {
    await idb.put('stops', JSON.parse(JSON.stringify(st)));
    if (S.selId === st.id) $('sSaved').textContent = 'Saved on this phone';
    touch();
  } catch (e) { $('sSaved').textContent = 'Not saved'; toast(storageMsg(e)); }
}
const pending = new Map();
function schedule(st) {
  clearTimeout(pending.get(st.id));
  $('sSaved').textContent = 'Saving…';
  pending.set(st.id, setTimeout(() => { pending.delete(st.id); saveStop(st); }, 400));
}
function flushSaves() {
  for (const [id, t] of pending) {
    clearTimeout(t); pending.delete(id);
    const st = S.stops.find(p => p.id === id); if (st) saveStop(st);
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });
window.addEventListener('pagehide', flushSaves);

function openStop(id) { flushSaves(); const ps = S.stops.find(x => x.id === id); if (ps && ps.sheetId && S.cur.sheetId !== ps.sheetId && sheetById(ps.sheetId)) { S.cur.sheetId = ps.sheetId; syncSheet(); S.zoom = 1; touch(); } S.selId = id; S.armed = false; renderSurvey(); openSheet(); }
function openSheet() { $('sheet').hidden = false; $('sheet').scrollTop = 0; document.body.classList.add('editing'); renderSheet(true); }
function closeSheet() { flushSaves(); $('sheet').hidden = true; document.body.classList.remove('editing'); S.selId = null; setTimeout(applyUpdate, 300); }
$('sClose').onclick = () => { closeSheet(); renderSurvey(); backToPlan(); };
/* After Done: show the plan (or, with no plan, the top of the survey with + New stop). */
function backToPlan() {
  requestAnimationFrame(() => {
    const target = S.cur && S.cur.mapId ? $('mapPanel') : null;
    if (!target) { window.scrollTo({ top: 0 }); return; }
    const bar = document.querySelector('#surveyView .topbar');
    const y = target.getBoundingClientRect().top + window.scrollY - (bar ? bar.offsetHeight : 0) - 8;
    window.scrollTo({ top: Math.max(0, y) });
  });
}

function renderGps(p) {
  $('sGps').textContent = p.gps ? `GPS ${p.gps.lat}, ${p.gps.lon} (±${p.gps.acc} m)` : (S.cur.gps !== false ? 'GPS: waiting for a fix (optional)' : '');
}
function renderSheet(full) {
  const p = sel(); if (!p) { $('sheet').hidden = true; document.body.classList.remove('editing'); return; }
  $('sNum').textContent = 'Stop ' + p.n;
  $('sWhen').textContent = fmtDate(p.createdAt);
  if (full || document.activeElement !== $('sZone')) $('sZone').value = p.zone || '';
  if (full || document.activeElement !== $('sNote')) $('sNote').value = p.note || '';
  const ph = p.photos || [];
  $('sPhotos').innerHTML = ph.map((id, i) => { const n = photoMarks(p, id).length; return `<button data-i="${i}" aria-label="Open photo ${i + 1}${n ? `, ${n} arrow${n === 1 ? '' : 's'}` : ''}"><img data-blob="${id}" alt="">${photoName(p, id) ? `<span class="cap">${esc(photoName(p, id))}</span>` : ''}${n ? `<span class="mk">↗${n > 1 ? n : ''}</span>` : ''}</button>`; }).join('');
  $('sPhotos').querySelectorAll('button').forEach(b => (b.onclick = () => openLightbox(+b.dataset.i)));
  hydrate($('sPhotos'));
  const zones = [...new Set(S.stops.map(x => x.zone).filter(Boolean))].filter(z => z !== p.zone).slice(-6);
  $('sChips').innerHTML = zones.map(z => `<button class="zchip" type="button">${esc(z)}</button>`).join('');
  $('sChips').querySelectorAll('.zchip').forEach((c, i) => (c.onclick = () => { $('sZone').value = zones[i]; setZone(zones[i]); }));
  renderGps(p);
  $('sIssue').checked = !!p.issue; $('sIssueBox').classList.toggle('on', !!p.issue);
  if (full) { $('sStatus').textContent = ''; $('sStatus').className = 'status'; $('sSaved').textContent = ''; }
}
function setZone(v) { const p = sel(); if (!p) return; p.zone = v; S.lastZone = v; schedule(p); renderStops(); }
$('sZone').addEventListener('input', e => setZone(e.target.value.trim()));
$('sNote').addEventListener('input', e => { const p = sel(); if (!p) return; p.note = e.target.value; schedule(p); });
$('sZone').addEventListener('blur', () => { flushSaves(); });
$('sNote').addEventListener('blur', () => { flushSaves(); renderStops(); });

function renderIssueCount() {
  const n = S.stops.filter(p => p.issue).length;
  $('cIssues').textContent = n; $('cIssuesWrap').hidden = !n;
  $('cIssuesLbl').textContent = n === 1 ? ' issue' : ' issues';
}
$('sIssue').onchange = async () => {
  const p = sel(); if (!p) return;
  p.issue = $('sIssue').checked;
  $('sIssueBox').classList.toggle('on', p.issue);
  await saveStop(p);
  renderMap(); renderStops(); renderIssueCount();
};

twoTap($('sDel'), 'Delete stop', 'Tap again to delete', async () => {
  const p = sel(); if (!p) return;
  try {
    for (const id of (p.photos || [])) { await idb.del('blobs', id); dropURL(id); }
    await idb.del('stops', p.id);
    S.stops = S.stops.filter(x => x.id !== p.id);
    closeSheet(); await touch(); renderSurvey(); toast('Stop ' + p.n + ' deleted');
  } catch (e) { toast('Could not delete: ' + (e.message || e)); }
});

/* ---------------- photos ---------------- */
async function addPhotos(files) {
  const p = sel(); if (!p || !files.length) return;
  const st = $('sStatus'); let ok = 0, bad = 0;
  for (const f of files) {
    st.className = 'status'; st.textContent = `Saving photo ${ok + bad + 1} of ${files.length}…`;
    try {
      const { blob } = await shrink(f, 2048, 0.82);
      const id = await putBlob(blob);
      p.photos = [...(p.photos || []), id];
      await saveStop(p); ok++;
      renderSheet(false); renderStops(); $('cPhotos').textContent = S.stops.reduce((a, x) => a + (x.photos?.length || 0), 0);
    } catch (e) { bad++; st.className = 'status err'; st.textContent = storageMsg(e); }
  }
  if (!bad) { st.className = 'status ok'; st.textContent = `${ok} photo${ok === 1 ? '' : 's'} saved on this phone.`; }
  return ok;
}
$('sCam').onclick = () => $('camFile').click();
$('sLib').onclick = () => $('libFile').click();
/* After taking a photo, open it straight away with the name box ready */
$('camFile').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  const ok = await addPhotos(files);
  const p = sel();
  if (ok && p && p.photos.length) {
    openLightbox(p.photos.length - 1);
    const n = $('lbName'); n.classList.add('prompt'); n.focus();
    setTimeout(() => n.classList.remove('prompt'), 2500);
  }
};
$('libFile').onchange = e => { addPhotos([...e.target.files]); e.target.value = ''; };

let lbIdx = 0;
function openLightbox(i) {
  const p = sel(); if (!p) return; lbIdx = i;
  lbZoomReset(); setArrowMode(false); ARW.draft = null;
  $('lbMarks').innerHTML = '';
  $('lb').hidden = false;
  blobURL(p.photos[i]).then(u => { const im = $('lbImg'); if (im.getAttribute('src') !== u) im.src = u; else lbFit(); });
  $('lbCap').textContent = `Stop ${p.n} · photo ${i + 1} of ${p.photos.length}`;
  $('lbName').value = photoName(p, p.photos[i]);
}
/* ---- Photo names: stored per photo id on the stop ---- */
function photoName(p, id) { return (p && p.captions && p.captions[id]) || ''; }
let lbNameT;
$('lbName').addEventListener('input', () => {
  const p = sel(); if (!p) return;
  const id = p.photos[lbIdx], v = $('lbName').value.trim();
  p.captions = p.captions || {};
  if (v) p.captions[id] = v; else delete p.captions[id];
  clearTimeout(lbNameT); lbNameT = setTimeout(() => { saveStop(p); renderSheet(false); }, 400);
});
$('lbName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('lbName').blur(); } });
$('lbName').addEventListener('blur', () => { const p = sel(); if (p) { clearTimeout(lbNameT); saveStop(p); renderSheet(false); } });
$('lbClose').onclick = () => { $('lbName').blur(); setArrowMode(false); $('lb').hidden = true; setTimeout(applyUpdate, 300); };
/* Size the photo (and its arrow layer) to fit the viewer */
function lbFit() {
  const im = $('lbImg'), st = $('lbStage'), box = $('lbPic');
  if (!im.naturalWidth) return;
  const k = Math.min(box.clientWidth / im.naturalWidth, box.clientHeight / im.naturalHeight);
  st.style.width = Math.round(im.naturalWidth * k) + 'px'; st.style.height = Math.round(im.naturalHeight * k) + 'px';
  renderMarks();
}
$('lbImg').addEventListener('load', lbFit);
if (window.ResizeObserver) new ResizeObserver(() => { if (!$('lb').hidden) { lbFit(); lbClamp(); lbApply(); } }).observe($('lbPic'));

/* ---- Arrow annotations: stored per photo as {x1,y1 (tail), x2,y2 (tip)} in 0..1 image coords; the photo itself is untouched ---- */
const ARW = { on: false, draft: null };
const ARROW_RED = '#E5372B';
function photoMarks(p, id) { return (p && p.marks && p.marks[id]) || []; }
function curMarks() { const p = sel(); return p ? photoMarks(p, p.photos[lbIdx]) : []; }
function arrowGeom(a, W, H, unit) {
  const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H;
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const L = Math.min(52 * unit, len * 0.6), hw = L * 0.5;
  const bx = x2 - ux * L, by = y2 - uy * L, px = -uy, py = ux;
  return { x1, y1, sx: x2 - ux * L * 0.6, sy: y2 - uy * L * 0.6, tip: [x2, y2], b1: [bx + px * hw, by + py * hw], b2: [bx - px * hw, by - py * hw] };
}
function arrowSVG(a, W, H) {
  const g = arrowGeom(a, W, H, 1), pts = [g.tip, g.b1, g.b2].map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  return `<g><line x1="${g.x1}" y1="${g.y1}" x2="${g.sx}" y2="${g.sy}" stroke="#fff" stroke-width="18" stroke-linecap="round"/>
    <polygon points="${pts}" fill="#fff" stroke="#fff" stroke-width="9" stroke-linejoin="round"/>
    <line x1="${g.x1}" y1="${g.y1}" x2="${g.sx}" y2="${g.sy}" stroke="${ARROW_RED}" stroke-width="10" stroke-linecap="round"/>
    <polygon points="${pts}" fill="${ARROW_RED}"/></g>`;
}
function drawArrowsCanvas(ctx, W, H, marks) {
  const unit = W / 1000, HH = H;
  for (const a of marks) {
    const g = arrowGeom(a, W, HH, unit);
    const tri = () => { ctx.beginPath(); ctx.moveTo(...g.tip); ctx.lineTo(...g.b1); ctx.lineTo(...g.b2); ctx.closePath(); };
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 18 * unit; ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.sx, g.sy); ctx.stroke();
    tri(); ctx.fillStyle = '#fff'; ctx.lineWidth = 9 * unit; ctx.fill(); ctx.stroke();
    ctx.strokeStyle = ARROW_RED; ctx.lineWidth = 10 * unit; ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.sx, g.sy); ctx.stroke();
    tri(); ctx.fillStyle = ARROW_RED; ctx.fill(); ctx.restore();
  }
}
function renderMarks() {
  const svg = $('lbMarks'), im = $('lbImg');
  $('lbUndo').disabled = !curMarks().length;
  if (!im.naturalWidth) { svg.innerHTML = ''; return; }
  const W = 1000, H = Math.round(1000 * im.naturalHeight / im.naturalWidth);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const list = [...curMarks()]; if (ARW.draft) list.push(ARW.draft);
  // keep the arrow stroke a constant on-screen size: viewBox is 1000 wide, stage is its fitted width
  svg.innerHTML = list.map(a => arrowSVG(a, W, H)).join('');
}
function setArrowMode(on) {
  ARW.on = on; ARW.draft = null;
  $('lbArrow').classList.toggle('armed', on);
  $('lbArrow').textContent = on ? 'Done adding arrows' : '↗ Arrow';
  $('lb').classList.toggle('drawing', on);
  const h = $('lbHint');
  h.textContent = on ? 'Drag from where the arrow starts to the thing it points at. Tap to drop a quick arrow.' : 'Pinch to zoom · double-tap to zoom in or out';
  h.classList.toggle('live', on);
}
$('lbArrow').onclick = () => setArrowMode(!ARW.on);
function lbNorm(x, y) {
  const r = $('lbStage').getBoundingClientRect();
  return { u: Math.max(0, Math.min(1, (x - r.left) / r.width)), v: Math.max(0, Math.min(1, (y - r.top) / r.height)) };
}
function drawStart(x, y) { const n = lbNorm(x, y); ARW.draft = { x1: n.u, y1: n.v, x2: n.u, y2: n.v }; renderMarks(); }
function drawMove(x, y) { if (!ARW.draft) return; const n = lbNorm(x, y); ARW.draft.x2 = n.u; ARW.draft.y2 = n.v; renderMarks(); }
async function drawEnd() {
  const a = ARW.draft; ARW.draft = null; if (!a) return;
  const im = $('lbImg'), ar = im.naturalHeight / im.naturalWidth || 1;
  if (Math.hypot(a.x2 - a.x1, (a.y2 - a.y1) * ar) < 0.03) { // a tap: quick arrow pointing at the tap from lower-left
    const tx = a.x1, ty = a.y1, off = 0.15;
    a.x2 = tx; a.y2 = ty;
    a.x1 = tx - off >= 0 ? tx - off : tx + off;
    a.y1 = ty + off / ar <= 1 ? ty + off / ar : ty - off / ar;
  }
  const r4 = n => Math.round(n * 10000) / 10000;
  const p = sel(); if (!p) return;
  const id = p.photos[lbIdx];
  p.marks = p.marks || {};
  p.marks[id] = [...photoMarks(p, id), { x1: r4(a.x1), y1: r4(a.y1), x2: r4(a.x2), y2: r4(a.y2) }];
  await saveStop(p); renderMarks(); renderSheet(false);
}
$('lbUndo').onclick = async () => {
  const p = sel(); if (!p) return; const id = p.photos[lbIdx];
  const m = photoMarks(p, id); if (!m.length) return;
  p.marks[id] = m.slice(0, -1); if (!p.marks[id].length) delete p.marks[id];
  await saveStop(p); renderMarks(); renderSheet(false);
};

/* Photo viewer zoom: pinch, one-finger pan while zoomed, double-tap, ctrl/trackpad pinch on desktop */
const LB = { s: 1, x: 0, y: 0 };
function lbApply() { $('lbStage').style.transform = `translate(${LB.x}px,${LB.y}px) scale(${LB.s})`; }
function lbZoomReset() { LB.s = 1; LB.x = 0; LB.y = 0; lbApply(); }
function lbClamp() {
  if (LB.s <= 1.001) { LB.s = 1; LB.x = 0; LB.y = 0; return; }
  const img = $('lbStage'), box = $('lbPic').getBoundingClientRect();
  const mx = Math.max(0, (img.clientWidth * LB.s - box.width) / 2), my = Math.max(0, (img.clientHeight * LB.s - box.height) / 2);
  LB.x = Math.max(-mx, Math.min(mx, LB.x)); LB.y = Math.max(-my, Math.min(my, LB.y));
}
function lbZoomTo(s, fx, fy) { // fx, fy: point relative to the viewer centre
  const u = (fx - LB.x) / LB.s, v = (fy - LB.y) / LB.s;
  LB.s = Math.max(1, Math.min(6, s)); LB.x = fx - u * LB.s; LB.y = fy - v * LB.s;
  lbClamp(); lbApply();
}
(function attachLbZoom() {
  const pic = $('lbPic');
  const rel = (x, y) => { const r = pic.getBoundingClientRect(); return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) }; };
  let pinch = null, pan = null, lastTap = 0;
  pic.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches;
    if (ARW.on && t.length === 1) { drawStart(t[0].clientX, t[0].clientY); pan = null; return; }
    if (t.length === 2) { ARW.draft = null; renderMarks(); }
    if (t.length === 2) {
      const m = rel((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
      pinch = { d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1, s: LB.s, u: (m.x - LB.x) / LB.s, v: (m.y - LB.y) / LB.s };
      pan = null;
    } else if (t.length === 1) {
      const now = Date.now(), p = rel(t[0].clientX, t[0].clientY);
      if (now - lastTap < 300) { lbZoomTo(LB.s > 1 ? 1 : 2.5, p.x, p.y); lastTap = 0; pan = null; return; }
      lastTap = now;
      pan = { x0: t[0].clientX, y0: t[0].clientY, x: LB.x, y: LB.y };
    }
  }, { passive: false });
  pic.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches;
    if (ARW.on && ARW.draft && t.length === 1) { drawMove(t[0].clientX, t[0].clientY); return; }
    if (pinch && t.length === 2) {
      const m = rel((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
      LB.s = Math.max(1, Math.min(6, pinch.s * Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) / pinch.d));
      LB.x = m.x - pinch.u * LB.s; LB.y = m.y - pinch.v * LB.s;
      lbClamp(); lbApply();
    } else if (pan && t.length === 1 && LB.s > 1) {
      LB.x = pan.x + (t[0].clientX - pan.x0); LB.y = pan.y + (t[0].clientY - pan.y0);
      lbClamp(); lbApply();
    }
  }, { passive: false });
  const end = e => {
    if (ARW.draft && !e.touches.length) { drawEnd(); return; }
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length === 1) pan = { x0: e.touches[0].clientX, y0: e.touches[0].clientY, x: LB.x, y: LB.y };
    if (!e.touches.length) pan = null;
  };
  pic.addEventListener('touchend', end); pic.addEventListener('touchcancel', end);
  pic.addEventListener('wheel', e => {
    e.preventDefault();
    const p = rel(e.clientX, e.clientY);
    if (e.ctrlKey) lbZoomTo(LB.s * Math.exp(-e.deltaY * 0.01), p.x, p.y);
    else if (LB.s > 1) { LB.x -= e.deltaX; LB.y -= e.deltaY; lbClamp(); lbApply(); }
  }, { passive: false });
  pic.addEventListener('dblclick', e => { if (ARW.on) return; const p = rel(e.clientX, e.clientY); lbZoomTo(LB.s > 1 ? 1 : 2.5, p.x, p.y); });
  pic.addEventListener('mousedown', e => { if (ARW.on) { e.preventDefault(); drawStart(e.clientX, e.clientY); } });
  window.addEventListener('mousemove', e => { if (ARW.on && ARW.draft) drawMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', () => { if (ARW.on && ARW.draft) drawEnd(); });
  window.addEventListener('resize', () => { if (!$('lb').hidden) { lbFit(); lbClamp(); lbApply(); } });
})();
twoTap($('lbDel'), 'Remove', 'Tap again to remove', async () => {
  const p = sel(); if (!p) return;
  const gone = p.photos[lbIdx];
  p.photos = p.photos.filter((_, i) => i !== lbIdx);
  if (p.marks) delete p.marks[gone];
  if (p.captions) delete p.captions[gone];
  await saveStop(p);
  try { await idb.del('blobs', gone); } catch (_) {}
  dropURL(gone);
  $('lb').hidden = true; renderSurvey(); toast('Photo removed');
});

/* ---------------- plans (PDF or image) ---------------- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

async function renderPdfPage(pdf, n, maxSide) {
  const page = await pdf.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  let scale = maxSide / Math.max(v1.width, v1.height);
  const px = v1.width * v1.height * scale * scale;
  if (px > 16e6) scale *= Math.sqrt(16e6 / px); // iOS canvas limit
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}
function busy(msg) {
  const P = $('mapPanel'); P.hidden = false; P.dataset.mode = 'busy';
  P.innerHTML = `<div class="empty"><h2>${esc(msg)}</h2><p class="sub">Large plan sets can take a few seconds.</p></div>`;
}
async function pdfSheetBlob(pdf, n) {
  const c = await renderPdfPage(pdf, n, 4096);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
  if (!blob) throw new Error('The sheet could not be converted');
  return { blob, w: c.width, h: c.height };
}
async function addPdfPages(pdf, pages, labels, base) {
  const items = []; let k = 0;
  for (const n of pages) {
    k++; busy(pages.length > 1 ? `Preparing sheet ${k} of ${pages.length}…` : 'Preparing the sheet…');
    const r = await pdfSheetBlob(pdf, n);
    items.push({ ...r, name: (labels && labels[n - 1]) || (pdf.numPages > 1 ? `Page ${n}` : base) });
  }
  await applySheets(items);
}
/* Add sheets to the survey, or replace the image of the current sheet. */
async function applySheets(items) {
  const s = S.cur;
  if (S.fileMode === 'replace' && curSheet() && items.length) {
    const sh = curSheet(), old = sh.mapId, it = items[0];
    sh.mapId = await putBlob(it.blob); sh.w = it.w; sh.h = it.h;
    try { await idb.del('blobs', old); } catch (_) {} dropURL(old);
  } else {
    let firstId = null;
    for (const it of items) {
      const sh = { id: uid(), name: String(it.name || 'Sheet').slice(0, 40), mapId: await putBlob(it.blob), w: it.w, h: it.h };
      s.sheets.push(sh); firstId = firstId || sh.id;
    }
    if (firstId) s.sheetId = firstId;
  }
  s.noMap = false; syncSheet(); await touch();
  const n = items.length, replaced = S.fileMode === 'replace';
  S.zoom = 1; S.fileMode = 'add'; S.sheetKey = ''; $('mapPanel').dataset.mode = ''; renderSurvey(true);
  toast(replaced ? 'Sheet replaced.' : n > 1 ? `${n} sheets added. Switch between them with the tabs above the plan.` : (s.sheets.length > 1 ? 'Sheet added.' : 'Plan loaded. Tap Drop pin to start.'), 4000);
}
async function pickSheets(pdf, labels) {
  const P = $('mapPanel'); P.hidden = false; P.dataset.mode = 'pick';
  const N = pdf.numPages, M = Math.min(N, 60), replace = S.fileMode === 'replace';
  P.innerHTML = `<div class="empty"><h2>${replace ? 'Pick the replacement sheet' : 'Pick the sheets'}</h2>
    <p class="sub">This PDF has ${N} pages${N > 60 ? ' (showing the first 60)' : ''}. ${replace ? 'Tap the page to use.' : 'Tap every page your walk covers, then tap Add.'}</p>
    <div class="sheets" id="sheetGrid"></div>
    <div class="row"><button class="btn primary" id="sheetAdd" ${replace ? 'hidden' : ''} disabled>Add sheets</button><button class="btn" id="sheetCancel">Cancel</button></div></div>`;
  const picked = new Set();
  $('sheetCancel').onclick = () => { P.dataset.mode = ''; S.fileMode = 'add'; renderSurvey(); };
  const go = async (pages) => {
    try { await addPdfPages(pdf, pages, labels, 'Sheet'); }
    catch (err) { P.dataset.mode = ''; renderSurvey(); toast('Could not use that sheet: ' + (err.message || err)); }
  };
  $('sheetAdd').onclick = () => { if (picked.size) go([...picked].sort((a, b) => a - b)); };
  const grid = $('sheetGrid');
  for (let i = 1; i <= M; i++) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="hint">${esc((labels && labels[i - 1]) || 'Page ' + i)}</span>`;
    b.onclick = () => {
      if (replace) { grid.querySelectorAll('button').forEach(x => (x.disabled = true)); go([i]); return; }
      if (picked.has(i)) { picked.delete(i); b.classList.remove('picked'); } else { picked.add(i); b.classList.add('picked'); }
      const a = $('sheetAdd'); a.disabled = !picked.size;
      a.textContent = picked.size ? `Add ${picked.size} sheet${picked.size === 1 ? '' : 's'}` : 'Add sheets';
    };
    grid.appendChild(b);
  }
  for (let i = 1; i <= M; i++) {
    if (P.dataset.mode !== 'pick') break;
    try { const c = await renderPdfPage(pdf, i, 260); grid.children[i - 1]?.prepend(c); } catch (_) {}
  }
}
$('mapFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !S.cur) return;
  if (S.fileMode === 'replace' && !curSheet()) S.fileMode = 'add';
  const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const base = f.name.replace(/\.[^.]+$/, '').trim().slice(0, 40) || 'Sheet';
  try {
    if (isPdf) {
      if (!window.pdfjsLib) throw new Error('the PDF reader did not load');
      toast('Opening PDF…');
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      let labels = null; try { labels = await pdf.getPageLabels(); } catch (_) {}
      if (pdf.numPages === 1) await addPdfPages(pdf, [1], labels, base); else await pickSheets(pdf, labels);
    } else {
      busy('Preparing the plan…');
      const r = await shrink(f, 4096, 0.88);
      await applySheets([{ ...r, name: base }]);
    }
  } catch (err) { $('mapPanel').dataset.mode = ''; S.fileMode = 'add'; renderSurvey(); toast('Could not load that plan: ' + (err.message || err), 4500); }
};

/* ---------------- PDF report ---------------- */
async function reportImage(id, max, drawPins) {
  const b = await getBlob(id); if (!b) return null;
  const u = URL.createObjectURL(b);
  try {
    const im = await loadImg(u);
    const s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(im, 0, 0, c.width, c.height);
    if (drawPins) drawPins(ctx, c.width, c.height);
    return { data: c.toDataURL('image/jpeg', 0.8), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(u); }
}
/* Draw one numbered pin whose tip sits at (px, py). */
function drawPin(ctx, px, py, r, p, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(r * 1.05)}px Arial, Helvetica, sans-serif`;
  const y = py - r * 1.4;
  ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(2, r * 0.18);
  ctx.beginPath(); ctx.moveTo(px, y + r); ctx.lineTo(px, py); ctx.stroke();
  ctx.beginPath(); ctx.arc(px, y, r, 0, Math.PI * 2);
  ctx.fillStyle = p.issue ? '#E5372B' : '#C6F432'; ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.2); ctx.strokeStyle = '#14181B'; ctx.stroke();
  ctx.fillStyle = p.issue ? '#fff' : '#000'; ctx.fillText(String(p.n), px, y + r * 0.05);
  ctx.restore();
}
function pinPainter(stops) {
  return (ctx, w, h) => {
    const r = Math.max(14, Math.max(w, h) * 0.016);
    for (const p of stops) if (p.x != null) drawPin(ctx, p.x * w, p.y * h, r, p);
  };
}
/* Fraction of the sheet's longer side shown in each stop's plan close-up. */
const SNIP_FRACTION = 0.28;

async function buildReport(progress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  const W = 612, H = 792, M = 54, CW = W - 2 * M, CT = 64, BOTTOM = H - 58;
  /* Close-up of the plan around one stop's pin, cut from the full-resolution sheet. */
  const sheetImgs = new Map();
  const planSnip = async (sh, p, onSheet) => {
    if (!sheetImgs.has(sh.id)) sheetImgs.set(sh.id, await loadImg(await blobURL(sh.mapId)));
    const im = sheetImgs.get(sh.id), IW = im.naturalWidth, IH = im.naturalHeight;
    let cw = Math.round(Math.max(IW, IH) * SNIP_FRACTION), ch = Math.round(cw * 0.75);
    cw = Math.min(cw, IW); ch = Math.min(ch, IH);
    const sx = Math.max(0, Math.min(IW - cw, Math.round(p.x * IW - cw / 2)));
    const sy = Math.max(0, Math.min(IH - ch, Math.round(p.y * IH - ch / 2)));
    const outW = 800, outH = Math.round(800 * ch / cw), k = outW / cw;
    const c = document.createElement('canvas'); c.width = outW; c.height = outH;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(im, sx, sy, cw, ch, 0, 0, outW, outH);
    for (const q of onSheet) {
      if (q.id === p.id) continue;
      const qx = (q.x * IW - sx) * k, qy = (q.y * IH - sy) * k;
      if (qx > -40 && qy > -10 && qx < outW + 40 && qy < outH + 60) drawPin(ctx, qx, qy, 24, q, 0.5);
    }
    const px = (p.x * IW - sx) * k, py = (p.y * IH - sy) * k;
    ctx.save(); ctx.strokeStyle = p.issue ? '#E5372B' : '#14181B'; ctx.lineWidth = 7; ctx.setLineDash([18, 12]);
    ctx.beginPath(); ctx.arc(px, py - 30, 92, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    drawPin(ctx, px, py, 36, p);
    return { data: c.toDataURL('image/jpeg', 0.82), w: outW, h: outH };
  };
  const ACCENT = [198, 244, 50], BLACK = [20, 24, 27], MID = [89, 94, 98], DIV = [204, 208, 210], LO = [246, 251, 226], RED = [211, 47, 47], RED_SOFT = [253, 236, 234];
  const s = S.cur, stops = [...S.stops].sort((a, b) => a.n - b.n);
  const totalPhotos = stops.reduce((a, p) => a + (p.photos?.length || 0), 0);
  const issues = stops.filter(p => p.issue);
  let y = CT;
  const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = CT; return true; } return false; };
  const sectionHead = (t) => {
    ensure(40);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...BLACK);
    doc.text(t, M, y + 12);
    doc.setDrawColor(...ACCENT); doc.setLineWidth(3); doc.line(M, y + 18, M + CW, y + 18);
    y += 30;
  };

  // Title block
  doc.setFillColor(...BLACK); doc.rect(M, y, CW, 108, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...ACCENT);
  doc.text('SITE WALK SURVEY', M + 18, y + 26, { charSpace: 1.2 });
  doc.setFontSize(21); doc.setTextColor(255, 255, 255);
  const tl = doc.splitTextToSize(s.name || 'Untitled survey', CW - 36).slice(0, 2);
  doc.text(tl, M + 18, y + 52);
  const meta = [['Surveyor', s.surveyor || '—'], ['Date', fmtDate(s.createdAt, false)], ['Stops', String(stops.length)], ['Photos', String(totalPhotos)], ['Issues', String(issues.length)]];
  let mx = M + 18; doc.setFontSize(9);
  for (const [k, v] of meta) {
    doc.setFont('helvetica', 'normal'); doc.setTextColor(170, 170, 170); doc.text(k.toUpperCase(), mx, y + 88, { charSpace: 0.6 });
    doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
    const vv = doc.splitTextToSize(v, 140)[0]; doc.text(vv, mx, y + 100);
    mx += Math.max(70, doc.getTextWidth(vv) + 28, doc.getTextWidth(k.toUpperCase()) + 28);
  }
  y += 108 + 20;

  // Plan sheets with pins
  const sheets = (s.sheets || []).filter(sh => sh.mapId);
  const multi = sheets.length > 1;
  const sheetName = id => (sheets.find(x => x.id === id) || {}).name || '';
  let plansDrawn = 0;
  for (const sh of sheets) {
    const pins = stops.filter(p => p.sheetId === sh.id && p.x != null);
    if (multi && !pins.length) continue;
    progress(multi ? `Adding ${sh.name}…` : 'Adding the plan…');
    const img = await reportImage(sh.mapId, 3000, pinPainter(pins));
    if (img) {
      if (plansDrawn) { doc.addPage(); y = CT; }
      plansDrawn++;
      sectionHead(multi ? `Site plan — ${sh.name}` : 'Site plan');
      let w = CW, h = CW * img.h / img.w;
      const maxH = BOTTOM - y - 18;
      if (h > maxH) { h = maxH; w = h * img.w / img.h; }
      const x = M + (CW - w) / 2;
      doc.addImage(img.data, 'JPEG', x, y, w, h, undefined, 'FAST');
      doc.setDrawColor(...DIV); doc.setLineWidth(0.75); doc.rect(x, y, w, h);
      y += h + 12;
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(...MID);
      const cap = (multi ? `Stops on this sheet: ${pins.map(p => p.n).join(', ')}. ` : 'Numbered pins mark where each stop was documented. ') + (pins.some(p => p.issue) ? 'Red pins are issues.' : '');
      doc.text(doc.splitTextToSize(cap, CW), M, y + 4);
      y += 18;
    }
  }

  if (plansDrawn) { doc.addPage(); y = CT; }

  // Issues
  if (issues.length) {
    ensure(40);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...RED);
    doc.text(`Issues (${issues.length})`, M, y + 12);
    doc.setDrawColor(...RED); doc.setLineWidth(3); doc.line(M, y + 18, M + CW, y + 18);
    y += 30;
    for (const p of issues) {
      doc.setFontSize(10);
      let nl = p.note ? doc.splitTextToSize(p.note, CW - 44) : [];
      if (nl.length > 6) { nl = nl.slice(0, 6); nl[5] = nl[5].replace(/.{0,3}$/, '…'); }
      const zl = doc.splitTextToSize(p.zone || 'No location named', CW - 44);
      const h = 14 + zl.length * 13 + nl.length * 13 + 14;
      ensure(Math.min(h, 120));
      const top = y;
      doc.setFillColor(...RED_SOFT); doc.rect(M, top, CW, h, 'F');
      doc.setFillColor(...RED); doc.rect(M, top, 3, h, 'F');
      doc.circle(M + 20, top + 17, 9, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
      doc.text(String(p.n), M + 20, top + 20.2, { align: 'center' });
      doc.setFontSize(10.5); doc.setTextColor(...BLACK);
      y = top + 20;
      for (const l of zl) { doc.text(l, M + 38, y); y += 13; }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      for (const l of nl) { doc.text(l, M + 38, y); y += 13; }
      doc.setFontSize(8.5); doc.setTextColor(...MID);
      doc.text(`Stop ${p.n}${multi && sheetName(p.sheetId) ? ' · ' + sheetName(p.sheetId) : ''} · ${p.photos?.length || 0} photo${(p.photos?.length || 0) === 1 ? '' : 's'} · details below`, M + 38, y); 
      y = Math.max(y, top + h) + 8;
    }
    y += 16;
  }

  // Summary table
  sectionHead('Stop summary');
  const cols = multi
    ? [{ t: '#', w: 30 }, { t: 'Location', w: 130 }, { t: 'Sheet', w: 84 }, { t: 'Notes', w: 206 }, { t: 'Photos', w: 54 }]
    : [{ t: '#', w: 30 }, { t: 'Location', w: 150 }, { t: 'Notes', w: 270 }, { t: 'Photos', w: 54 }];
  const cNote = multi ? 3 : 2;
  const head = () => {
    doc.setFillColor(...BLACK); doc.rect(M, y, CW, 22, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
    let cx = M; for (const c of cols) { doc.text(c.t, cx + 7, y + 14.5); cx += c.w; }
    y += 22;
  };
  head();
  stops.forEach((p, i) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    const zl = doc.splitTextToSize(p.zone || '—', cols[1].w - 14).slice(0, 3);
    let nl = doc.splitTextToSize((p.note || '—').replace(/\s+/g, ' '), cols[cNote].w - 14);
    if (nl.length > 3) { nl = nl.slice(0, 3); nl[2] = nl[2].replace(/.{0,3}$/, '…'); }
    const shl = multi ? doc.splitTextToSize(sheetName(p.sheetId) || '—', cols[2].w - 14).slice(0, 3) : [];
    const rh = Math.max(zl.length, nl.length, shl.length) * 11.5 + 11;
    if (ensure(rh)) head();
    if (p.issue) { doc.setFillColor(...RED_SOFT); doc.rect(M, y, CW, rh, 'F'); doc.setFillColor(...RED); doc.rect(M, y, 3, rh, 'F'); }
    else if (i % 2 === 0) { doc.setFillColor(...LO); doc.rect(M, y, CW, rh, 'F'); }
    doc.setDrawColor(...DIV); doc.setLineWidth(0.5); doc.line(M, y + rh, M + CW, y + rh);
    doc.setTextColor(...BLACK);
    let cx = M;
    doc.setFont('helvetica', 'bold'); if (p.issue) doc.setTextColor(...RED); doc.text(String(p.n), cx + 7, y + 15); cx += cols[0].w;
    doc.text(zl, cx + 7, y + 15, { lineHeightFactor: 1.28 }); doc.setTextColor(...BLACK); cx += cols[1].w;
    doc.setFont('helvetica', 'normal');
    if (multi) { doc.text(shl, cx + 7, y + 15, { lineHeightFactor: 1.28 }); cx += cols[2].w; }
    doc.text(nl, cx + 7, y + 15, { lineHeightFactor: 1.28 }); cx += cols[cNote].w;
    doc.text(String(p.photos?.length || 0), cx + 7, y + 15);
    y += rh;
  });
  y += 24;

  // Stop details
  // Stops with photos always start on a fresh page, so a stop's title never sits apart from its photos
  const hasPhotos = p => (p.photos?.length || 0) > 0;
  if (stops.length && hasPhotos(stops[0]) && y > CT) { doc.addPage(); y = CT; }
  sectionHead('Stop details');
  const detailsTop = y;
  let done = 0;
  for (const p of stops) {
    if (hasPhotos(p) && y > detailsTop && y > CT) { doc.addPage(); y = CT; }
    const shp = p.x != null ? sheets.find(x => x.id === p.sheetId) : null;
    let snip = null;
    if (shp) { progress(`Adding plan detail for stop ${p.n}…`); try { snip = await planSnip(shp, p, stops.filter(q => q.sheetId === shp.id && q.x != null)); } catch (_) {} }
    ensure(snip ? 54 + 210 * snip.h / snip.w + 18 : 70);
    doc.setFillColor(...(p.issue ? RED_SOFT : LO)); doc.rect(M, y, CW, 28, 'F');
    doc.setDrawColor(...(p.issue ? RED : BLACK)); doc.setLineWidth(p.issue ? 2.5 : 1.5); doc.line(M, y, M + CW, y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...BLACK);
    doc.text(doc.splitTextToSize(`Stop ${p.n} — ${p.zone || 'No location named'}`, p.issue ? CW - 180 : CW - 130)[0], M + 10, y + 18);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MID);
    doc.text(fmtDate(p.createdAt), M + CW - 10, y + 18, { align: 'right' });
    if (p.issue) {
      const dw = doc.getTextWidth(fmtDate(p.createdAt));
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...RED);
      doc.text('ISSUE', M + CW - 22 - dw, y + 18, { align: 'right', charSpace: 0.8 });
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...MID);
    }
    y += 38;
    const sub = [`${p.photos?.length || 0} photo${(p.photos?.length || 0) === 1 ? '' : 's'}`];
    if (p.gps) sub.push(`GPS ${p.gps.lat}, ${p.gps.lon} (±${p.gps.acc} m)`);
    if (multi && sheetName(p.sheetId)) sub.push('Sheet: ' + sheetName(p.sheetId));
    if (sheets.length && p.x == null) sub.push('not pinned on plan');
    doc.text(sub.join('  ·  '), M, y); y += 16;
    if (snip) {
      // Plan close-up on the left, notes beside it
      const sw = 210, sh2 = sw * snip.h / snip.w;
      ensure(sh2 + 18);
      const top = y;
      doc.addImage(snip.data, 'JPEG', M, top, sw, sh2, undefined, 'FAST');
      doc.setDrawColor(...DIV); doc.setLineWidth(0.75); doc.rect(M, top, sw, sh2);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MID);
      doc.text('Plan detail' + (multi ? ' — ' + shp.name : ''), M, top + sh2 + 10);
      const nx = M + sw + 14, nw = CW - sw - 14;
      let ny = top, broke = false;
      if (p.note) {
        doc.setFontSize(10.5); doc.setTextColor(...BLACK);
        for (const line of doc.splitTextToSize(p.note, nw)) {
          if (ny + 15 > BOTTOM) { doc.addPage(); ny = CT; broke = true; }
          doc.text(line, broke ? M : nx, ny + 10); ny += 14.5;
        }
      }
      y = (broke ? ny : Math.max(top + sh2 + 14, ny)) + 12;
    } else if (p.note) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...BLACK);
      for (const line of doc.splitTextToSize(p.note, CW)) { ensure(15); doc.text(line, M, y + 4); y += 14.5; }
      y += 8;
    }
    const ph = p.photos || [];
    const gap = 12, colW = (CW - gap) / 2;
    for (let i = 0; i < ph.length; i += 2) {
      const pair = [];
      for (let j = i; j < Math.min(i + 2, ph.length); j++) {
        done++; progress(`Adding photo ${done} of ${totalPhotos}…`);
        const mk = photoMarks(p, ph[j]);
        const im = await reportImage(ph[j], 1400, mk.length ? (ctx, w, h) => drawArrowsCanvas(ctx, w, h, mk) : null);
        if (im) {
          let w = colW, h = colW * im.h / im.w;
          if (h > colW * 1.3) { h = colW * 1.3; w = h * im.w / im.h; }
          pair.push({ im, w, h, label: `${p.n}.${j + 1}`, name: photoName(p, ph[j]) });
        }
      }
      if (!pair.length) continue;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      pair.forEach(q => { q.lines = doc.splitTextToSize(`Photo ${q.label}${q.name ? ' — ' + q.name : ''}`, colW).slice(0, 2); });
      const capH = Math.max(...pair.map(q => q.lines.length)) * 10.5;
      const imgH = Math.max(...pair.map(q => q.h));
      const rowH = imgH + 6 + capH;
      ensure(rowH);
      pair.forEach((q, k) => {
        const x = M + k * (colW + gap) + (colW - q.w) / 2;
        doc.addImage(q.im.data, 'JPEG', x, y, q.w, q.h, undefined, 'FAST');
        doc.setFont('helvetica', q.name ? 'bold' : 'normal'); doc.setFontSize(8.5); doc.setTextColor(...(q.name ? BLACK : MID));
        doc.text(q.lines, M + k * (colW + gap), y + q.h + 12, { lineHeightFactor: 1.2 });
      });
      y += rowH + 8;
    }
    y += 14;
  }

  // Header + footer on every page
  const N = doc.getNumberOfPages();
  for (let i = 1; i <= N; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...BLACK);
    doc.text(BRAND.name, M, 38);
    const cw = doc.getTextWidth(BRAND.name);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...MID);
    doc.text('  |  ' + BRAND.tagline, M + cw, 38);
    doc.setFont('helvetica', 'italic');
    doc.text(doc.splitTextToSize(s.name || '', 220)[0] || '', M + CW, 38, { align: 'right' });
    doc.setDrawColor(...ACCENT); doc.setLineWidth(3); doc.line(M, 46, M + CW, 46);
    doc.line(M, H - 44, M + CW, H - 44);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MID);
    doc.text(BRAND.site || ('Generated ' + fmtDate(new Date().toISOString())), M, H - 30);
    doc.text(`Page ${i} of ${N}`, M + CW, H - 30, { align: 'right' });
  }
  return doc.output('blob');
}

let readyFile = null;
$('reportBtn').onclick = async () => {
  flushSaves();
  const btn = $('reportBtn'); btn.disabled = true; const label = 'Build report (PDF)';
  try {
    const blob = await buildReport(t => (btn.textContent = t));
    const date = new Date().toISOString().slice(0, 10);
    const base = (S.cur.name || 'site-walk').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'site-walk';
    readyFile = new File([blob], `${base}-site-walk-${date}.pdf`, { type: 'application/pdf' });
    const mb = blob.size / 1048576;
    $('readyInfo').textContent = `${readyFile.name} · ${mb < 1 ? Math.round(blob.size / 1024) + ' KB' : mb.toFixed(1) + ' MB'}. Share it to Mail, Teams, Files or AirDrop. If you are offline, save it now and send it later.`;
    $('readyShare').hidden = !(navigator.canShare && navigator.canShare({ files: [readyFile] }));
    $('ready').hidden = false;
  } catch (e) { toast('Could not build the report: ' + (e.message || e), 5000); }
  finally { btn.textContent = label; btn.disabled = !S.stops.length; }
};
$('readyShare').onclick = async () => {
  if (!readyFile) return;
  try { await navigator.share({ files: [readyFile], title: S.cur?.name || 'Site walk report' }); $('ready').hidden = true; }
  catch (e) { if (e.name !== 'AbortError') toast('Sharing did not work here. Use Save / open instead.'); }
};
$('readySave').onclick = () => {
  if (!readyFile) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(readyFile); a.download = readyFile.name; a.rel = 'noopener';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
};
$('readyClose').onclick = () => { $('ready').hidden = true; setTimeout(applyUpdate, 300); };

/* ---------------- connectivity, install, offline ---------------- */
let swReady = false;
function renderNet() {
  const on = navigator.onLine;
  for (const id of ['netChip', 'netChip2']) {
    const c = $(id);
    c.textContent = !on ? 'Offline · saving to phone' : (swReady ? 'Ready offline' : 'Setting up offline…');
    c.classList.toggle('off', !on);
  }
}
window.addEventListener('online', renderNet);
window.addEventListener('offline', renderNet);

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let deferredPrompt = null;
function renderInstall() {
  const b = $('installBanner');
  if (isStandalone() || ls.get('installDismissed', '') === '1') { b.hidden = true; return; }
  if (isIOS()) { $('installText').innerHTML = 'Install this on your phone: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>. Do it while you have a signal.'; b.hidden = false; }
  else if (deferredPrompt) { $('installText').textContent = 'Install Site Walk on this device so it opens without a signal.'; $('installGo').hidden = false; b.hidden = false; }
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; renderInstall(); });
$('installGo').onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice.catch(() => {}); deferredPrompt = null; $('installBanner').hidden = true; };
$('installX').onclick = () => { ls.set('installDismissed', '1'); $('installBanner').hidden = true; };

/* Updates: check for a new version on launch and every time the app comes back to the foreground
   (home-screen apps on iPhone usually resume rather than restart). When a new version takes over,
   reload into it right away, or as soon as the open stop / photo / report window is closed. */
const busyEditing = () => !$('sheet').hidden || !$('lb').hidden || !$('ready').hidden || $('mapPanel').dataset.mode === 'pick' || $('mapPanel').dataset.mode === 'busy';
function applyUpdate() {
  if (!S.pendingReload) return;
  if (busyEditing()) return;
  flushSaves();
  toast('Updating to the latest version…', 1500);
  setTimeout(() => location.reload(), 600);
}
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
    check();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    window.addEventListener('online', check);
    return navigator.serviceWorker.ready;
  }).then(() => { swReady = true; renderNet(); }).catch(() => { renderNet(); });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    swReady = true; renderNet();
    if (!hadController || S.pendingReload) return; // first install: nothing to reload
    S.pendingReload = true;
    if (busyEditing()) toast('A new version is ready. It will load when you close this window.', 4000);
    applyUpdate();
  });
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

/* ---------------- boot ---------------- */
renderNet(); renderInstall();
openDB().then(renderList).catch(e => {
  $('surveyList').innerHTML = `<div class="emptycard"><h3>Storage is not available</h3><p>This browser is blocking on-device storage (${esc(e && e.message || e)}). On iPhone, open the app from the Home Screen or a normal Safari tab, not a private tab.</p></div>`;
});
