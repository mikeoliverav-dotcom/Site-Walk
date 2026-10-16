'use strict';
/* Site Walk — offline site survey app.
   Everything is stored on the device in IndexedDB. No server, no account. */

const APP_VERSION = '1.3.0';
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
  const s = { id: uid(), name, surveyor, createdAt: now, updatedAt: now, mapId: null, mapW: 0, mapH: 0, noMap, gps: true };
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
  $('mapPanel').dataset.mode = ''; $('settings').open = false;
  show('survey'); renderSurvey(true);
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
        <ol><li>Pick the plan as a PDF or an image. For a multi-sheet PDF, you choose the sheet.</li>
        <li>Tap <b>Drop pin</b>, then tap where you're standing.</li>
        <li>Take photos and add notes for that spot. Everything saves on this phone.</li></ol>
        <div class="row"><button class="btn primary" id="upMap">Load plan (PDF or image)</button><button class="btn" id="noMap">Walk without a plan</button></div></div>`;
      $('upMap').onclick = () => $('mapFile').click();
      $('noMap').onclick = async () => { s.noMap = true; await touch(); renderSurvey(); };
    }
    return;
  }
  P.hidden = false;
  if (P.dataset.mode !== 'map') {
    P.dataset.mode = 'map';
    P.innerHTML = `<div class="mapbar"><span class="hint" id="mapHint"></span>
        <span class="zoom"><button id="zOut" aria-label="Zoom out">−</button><span id="zLbl">1×</span><button id="zIn" aria-label="Zoom in">+</button></span></div>
      <div class="mapscroll" id="mapScroll"><div class="mapinner" id="mapInner"><img id="mapImg" alt="Site plan"></div></div>`;
    $('zIn').onclick = () => setZoom(S.zoom * 1.5);
    $('zOut').onclick = () => setZoom(S.zoom / 1.5);
    $('mapInner').addEventListener('click', onMapTap);
  }
  blobURL(s.mapId).then(u => { const im = $('mapImg'); if (im && u && im.getAttribute('src') !== u) im.src = u; });
  const inner = $('mapInner');
  inner.style.width = (S.zoom * 100) + '%';
  inner.classList.toggle('armed', S.armed);
  $('zLbl').textContent = (Math.round(S.zoom * 10) / 10) + '×';
  const h = $('mapHint');
  h.textContent = S.armed ? 'Tap the plan where you are standing.' : 'Pins mark each stop. Tap a pin to open it.';
  h.classList.toggle('live', S.armed);
  inner.querySelectorAll('.pin').forEach(n => n.remove());
  for (const p of S.stops) {
    if (p.x == null) continue;
    const b = document.createElement('button');
    b.className = 'pin' + (p.issue ? ' issue' : '') + (p.id === S.selId ? ' sel' : '');
    b.style.left = (p.x * 100) + '%'; b.style.top = (p.y * 100) + '%';
    b.setAttribute('aria-label', 'Stop ' + p.n + (p.issue ? ' (issue)' : ''));
    b.innerHTML = `<span>${p.n}</span><i></i>`;
    b.onclick = (e) => { e.stopPropagation(); if (!S.armed) openStop(p.id); };
    inner.appendChild(b);
  }
}
function setZoom(z) {
  const sc = $('mapScroll');
  const cx = (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth;
  const cy = (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight;
  S.zoom = Math.max(1, Math.min(6, z));
  renderMap();
  sc.scrollLeft = cx * sc.scrollWidth - sc.clientWidth / 2;
  sc.scrollTop = cy * sc.scrollHeight - sc.clientHeight / 2;
}
function onMapTap(e) {
  if (!S.armed) return;
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
      <span class="sf"><span>${esc(fmtDate(p.createdAt))}</span><span>${ph.length} photo${ph.length === 1 ? '' : 's'}</span>${p.x == null && S.cur.mapId ? '<span>no pin</span>' : ''}</span>
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
  $('replaceMap').textContent = s.mapId ? 'Replace plan' : 'Load plan';
  $('replaceHint').hidden = !(s.mapId && S.stops.some(p => p.x != null));
}
let survT;
$('setSurveyor').addEventListener('input', () => {
  clearTimeout(survT);
  survT = setTimeout(() => { S.cur.surveyor = $('setSurveyor').value.trim(); ls.set('surveyor', S.cur.surveyor); touch(); $('svSurveyor').textContent = S.cur.surveyor ? 'Surveyor: ' + S.cur.surveyor : ''; }, 500);
});
$('setGps').onchange = () => { S.cur.gps = $('setGps').checked; touch(); };
$('replaceMap').onclick = () => $('mapFile').click();
twoTap($('delSurvey'), 'Delete survey', 'Tap again to delete for good', async () => {
  const s = S.cur; if (!s) return;
  try {
    for (const p of S.stops) {
      for (const id of (p.photos || [])) await idb.del('blobs', id);
      await idb.del('stops', p.id);
    }
    if (s.mapId) await idb.del('blobs', s.mapId);
    await idb.del('surveys', s.id);
    toast('Survey deleted');
    showList();
  } catch (e) { toast('Could not delete: ' + (e.message || e)); }
});

/* ---------------- stops ---------------- */
async function createStop(x, y) {
  const n = S.stops.reduce((m, p) => Math.max(m, p.n || 0), 0) + 1;
  const st = { id: uid(), surveyId: S.cur.id, n, x, y, zone: '', note: '', photos: [], issue: false, createdAt: new Date().toISOString(), gps: null };
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

function openStop(id) { flushSaves(); S.selId = id; S.armed = false; renderSurvey(); openSheet(); }
function openSheet() { $('sheet').hidden = false; $('sheet').scrollTop = 0; document.body.classList.add('editing'); renderSheet(true); }
function closeSheet() { flushSaves(); $('sheet').hidden = true; document.body.classList.remove('editing'); S.selId = null; }
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
  $('sPhotos').innerHTML = ph.map((id, i) => `<button data-i="${i}" aria-label="Open photo ${i + 1}"><img data-blob="${id}" alt=""></button>`).join('');
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
}
$('sCam').onclick = () => $('camFile').click();
$('sLib').onclick = () => $('libFile').click();
$('camFile').onchange = e => { addPhotos([...e.target.files]); e.target.value = ''; };
$('libFile').onchange = e => { addPhotos([...e.target.files]); e.target.value = ''; };

let lbIdx = 0;
function openLightbox(i) {
  const p = sel(); if (!p) return; lbIdx = i;
  blobURL(p.photos[i]).then(u => ($('lbImg').src = u));
  $('lbCap').textContent = `Stop ${p.n} · photo ${i + 1} of ${p.photos.length}`;
  $('lb').hidden = false;
}
$('lbClose').onclick = () => ($('lb').hidden = true);
twoTap($('lbDel'), 'Remove', 'Tap again to remove', async () => {
  const p = sel(); if (!p) return;
  const gone = p.photos[lbIdx];
  p.photos = p.photos.filter((_, i) => i !== lbIdx);
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
async function useSheet(pdf, n) {
  const P = $('mapPanel'); P.dataset.mode = 'busy';
  P.innerHTML = `<div class="empty"><h2>Preparing sheet ${n}…</h2><p class="sub">Large plan sets can take a few seconds.</p></div>`;
  const c = await renderPdfPage(pdf, n, 4096);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
  if (!blob) throw new Error('The sheet could not be converted');
  await setMap(blob, c.width, c.height);
}
async function pickSheet(pdf) {
  const P = $('mapPanel'); P.hidden = false; P.dataset.mode = 'pick';
  const N = pdf.numPages;
  P.innerHTML = `<div class="empty"><h2>Pick the sheet</h2>
    <p class="sub">This PDF has ${N} pages${N > 60 ? ' (showing the first 60)' : ''}. Tap the one to use as the plan.</p>
    <div class="sheets" id="sheetGrid"></div>
    <button class="btn" id="sheetCancel">Cancel</button></div>`;
  $('sheetCancel').onclick = () => { P.dataset.mode = ''; renderSurvey(); };
  const grid = $('sheetGrid');
  for (let i = 1; i <= Math.min(N, 60); i++) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="hint">Page ${i}</span>`;
    b.onclick = async () => {
      grid.querySelectorAll('button').forEach(x => (x.disabled = true));
      try { await useSheet(pdf, i); }
      catch (err) { P.dataset.mode = ''; renderSurvey(); toast('Could not use that sheet: ' + (err.message || err)); }
    };
    grid.appendChild(b);
  }
  for (let i = 1; i <= Math.min(N, 60); i++) {
    if (P.dataset.mode !== 'pick') break;
    try { const c = await renderPdfPage(pdf, i, 260); grid.children[i - 1]?.prepend(c); } catch (_) {}
  }
}
async function setMap(blob, w, h) {
  const old = S.cur.mapId;
  const id = await putBlob(blob);
  Object.assign(S.cur, { mapId: id, mapW: w, mapH: h, noMap: false });
  await touch();
  if (old) { try { await idb.del('blobs', old); } catch (_) {} dropURL(old); }
  S.zoom = 1; $('mapPanel').dataset.mode = ''; renderSurvey();
  toast('Plan loaded. Tap Drop pin to start.');
}
$('mapFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !S.cur) return;
  const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  try {
    if (isPdf) {
      if (!window.pdfjsLib) throw new Error('the PDF reader did not load');
      toast('Opening PDF…');
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      if (pdf.numPages === 1) await useSheet(pdf, 1); else await pickSheet(pdf);
    } else {
      toast('Loading plan…');
      const r = await shrink(f, 4096, 0.88);
      await setMap(r.blob, r.w, r.h);
    }
  } catch (err) { $('mapPanel').dataset.mode = ''; renderSurvey(); toast('Could not load that plan: ' + (err.message || err), 4500); }
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
function pinPainter(stops) {
  return (ctx, w, h) => {
    const r = Math.max(14, Math.max(w, h) * 0.016);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(r * 1.05)}px Arial, Helvetica, sans-serif`;
    for (const p of stops) {
      if (p.x == null) continue;
      const x = p.x * w, y = p.y * h - r * 1.4;
      ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(2, r * 0.18);
      ctx.beginPath(); ctx.moveTo(x, y + r); ctx.lineTo(x, p.y * h); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.issue ? '#E5372B' : '#C6F432'; ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.2); ctx.strokeStyle = '#14181B'; ctx.stroke();
      ctx.fillStyle = p.issue ? '#fff' : '#000'; ctx.fillText(String(p.n), x, y + r * 0.05);
    }
  };
}

async function buildReport(progress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  const W = 612, H = 792, M = 54, CW = W - 2 * M, CT = 64, BOTTOM = H - 58;
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

  // Plan with pins
  if (s.mapId) {
    progress('Adding the plan…');
    const img = await reportImage(s.mapId, 3000, pinPainter(stops));
    if (img) {
      sectionHead('Site plan');
      let w = CW, h = CW * img.h / img.w;
      const maxH = BOTTOM - y - 18;
      if (h > maxH) { h = maxH; w = h * img.w / img.h; }
      const x = M + (CW - w) / 2;
      doc.addImage(img.data, 'JPEG', x, y, w, h, undefined, 'FAST');
      doc.setDrawColor(...DIV); doc.setLineWidth(0.75); doc.rect(x, y, w, h);
      y += h + 12;
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(...MID);
      doc.text('Numbered pins mark where each stop was documented.' + (issues.length ? ' Red pins are issues.' : ''), M, y + 4);
      y += 18;
    }
  }

  if (s.mapId) { doc.addPage(); y = CT; }

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
      doc.text(`Stop ${p.n} · ${p.photos?.length || 0} photo${(p.photos?.length || 0) === 1 ? '' : 's'} · details below`, M + 38, y); 
      y = Math.max(y, top + h) + 8;
    }
    y += 16;
  }

  // Summary table
  sectionHead('Stop summary');
  const cols = [{ t: '#', w: 30 }, { t: 'Location', w: 150 }, { t: 'Notes', w: 270 }, { t: 'Photos', w: 54 }];
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
    let nl = doc.splitTextToSize((p.note || '—').replace(/\s+/g, ' '), cols[2].w - 14);
    if (nl.length > 3) { nl = nl.slice(0, 3); nl[2] = nl[2].replace(/.{0,3}$/, '…'); }
    const rh = Math.max(zl.length, nl.length) * 11.5 + 11;
    if (ensure(rh)) head();
    if (p.issue) { doc.setFillColor(...RED_SOFT); doc.rect(M, y, CW, rh, 'F'); doc.setFillColor(...RED); doc.rect(M, y, 3, rh, 'F'); }
    else if (i % 2 === 0) { doc.setFillColor(...LO); doc.rect(M, y, CW, rh, 'F'); }
    doc.setDrawColor(...DIV); doc.setLineWidth(0.5); doc.line(M, y + rh, M + CW, y + rh);
    doc.setTextColor(...BLACK);
    let cx = M;
    doc.setFont('helvetica', 'bold'); if (p.issue) doc.setTextColor(...RED); doc.text(String(p.n), cx + 7, y + 15); cx += cols[0].w;
    doc.text(zl, cx + 7, y + 15, { lineHeightFactor: 1.28 }); doc.setTextColor(...BLACK); cx += cols[1].w;
    doc.setFont('helvetica', 'normal'); doc.text(nl, cx + 7, y + 15, { lineHeightFactor: 1.28 }); cx += cols[2].w;
    doc.text(String(p.photos?.length || 0), cx + 7, y + 15);
    y += rh;
  });
  y += 24;

  // Stop details
  sectionHead('Stop details');
  let done = 0;
  for (const p of stops) {
    ensure(70);
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
    if (s.mapId && p.x == null) sub.push('not pinned on plan');
    doc.text(sub.join('  ·  '), M, y); y += 16;
    if (p.note) {
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
        const im = await reportImage(ph[j], 1400);
        if (im) {
          let w = colW, h = colW * im.h / im.w;
          if (h > colW * 1.3) { h = colW * 1.3; w = h * im.w / im.h; }
          pair.push({ im, w, h, label: `${p.n}.${j + 1}` });
        }
      }
      if (!pair.length) continue;
      const rowH = Math.max(...pair.map(q => q.h)) + 16;
      ensure(rowH);
      pair.forEach((q, k) => {
        const x = M + k * (colW + gap) + (colW - q.w) / 2;
        doc.addImage(q.im.data, 'JPEG', x, y, q.w, q.h, undefined, 'FAST');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MID);
        doc.text(`Photo ${q.label}`, M + k * (colW + gap), y + q.h + 11);
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
$('readyClose').onclick = () => ($('ready').hidden = true);

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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => { swReady = true; renderNet(); })
    .catch(() => { renderNet(); });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !S.cur) { swReady = true; renderNet(); return; }
    reloaded = true; toast('App updated. Close and reopen it to use the new version.', 5000);
  });
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

/* ---------------- boot ---------------- */
renderNet(); renderInstall();
openDB().then(renderList).catch(e => {
  $('surveyList').innerHTML = `<div class="emptycard"><h3>Storage is not available</h3><p>This browser is blocking on-device storage (${esc(e && e.message || e)}). On iPhone, open the app from the Home Screen or a normal Safari tab, not a private tab.</p></div>`;
});
