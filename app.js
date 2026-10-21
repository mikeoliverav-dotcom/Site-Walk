'use strict';
/* Site Walk — offline site survey app.
   Everything is saved on the device first (IndexedDB), so it works with no signal. When the app is hosted with
   its sync server (_worker.js on Cloudflare), surveys also sync to the signed-in person's account. */

const APP_VERSION = '2.4.0';
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

/* Room dimensions: stored as typed on the stop (p.dims = {w, d, h}); a bare number is read as feet. */
const DIM_KEYS = [['w', 'Width', 'W'], ['d', 'Depth', 'D'], ['h', 'Ceiling', 'Clg']];
const dimVal = v => { v = String(v || '').trim(); return /^\d+(\.\d+)?$/.test(v) ? v + "'" : v; };
const hasDims = p => !!(p && p.dims && DIM_KEYS.some(([k]) => p.dims[k]));
/* Short: "W 24' × D 18' · Clg 9'"; long: "Width 24' × Depth 18' · Ceiling 9'" */
function dimsText(p, long) {
  if (!hasDims(p)) return '';
  const d = p.dims, lab = k => DIM_KEYS.find(x => x[0] === k)[long ? 1 : 2];
  const wd = ['w', 'd'].filter(k => d[k]).map(k => `${lab(k)} ${dimVal(d[k])}`).join(' × ');
  return [wd, d.h ? `${lab('h')} ${dimVal(d.h)}` : ''].filter(Boolean).join(' · ');
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
  async has(s, k) { return (await done((await os(s)).count(k))) > 0; },
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
const S = { surveys: [], cur: null, stops: [], selId: null, armed: false, moving: null, zoom: 1, lastZone: '' };
const sel = () => S.stops.find(p => p.id === S.selId);
function show(view) { $('listView').hidden = view !== 'list'; $('surveyView').hidden = view !== 'survey'; window.scrollTo(0, 0); }
/* Save the open survey. `changed` = false for view-only changes (which sheet is showing), so they don't count as edits. */
async function touch(changed = true) {
  if (!S.cur || S.cur.readonly) return;
  if (changed) { S.cur.updatedAt = new Date().toISOString(); S.cur.seq = (S.cur.seq || 0) + 1; }
  try { await idb.put('surveys', { ...S.cur }); } catch (e) { toast(storageMsg(e)); }
  if (changed) scheduleSync(5000);
}

/* ---------------- survey list ---------------- */
const DAY = 86400e3;
const daysLeft = s => Math.ceil((s.expiresAt - Date.now()) / DAY);
const expSoon = s => !!(s.remote && !s.readonly && s.expiresAt && daysLeft(s) <= 7);
const expText = d => d <= 0 ? 'Deletes today' : d === 1 ? 'Deletes tomorrow' : `Deletes in ${d} days`;
async function renderList() {
  const all = await idb.all('surveys');
  const byDate = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');
  S.surveys = all.filter(s => !s.readonly).sort(byDate);
  const cached = new Map(all.filter(s => s.readonly).map(s => [s.id, s]));
  const allStops = await idb.all('stops');
  const L = $('surveyList'), sync = !!SYNC.available;
  if (!S.surveys.length) {
    L.innerHTML = `<div class="emptycard"><h3>No surveys yet</h3><p>Tap <b>New survey</b>, load the site plan, then drop a pin at each stop on your walk. Photos and notes save on this phone as you go, with or without a signal${sync ? ', and sync to your account when there is one' : ''}. When you're done, build the PDF report and share it with the team.${sync ? '' : ' To open a survey from another device, tap <b>Import</b>.'}</p></div>`;
  } else {
    L.innerHTML = S.surveys.map(s => {
      const st = allStops.filter(p => p.surveyId === s.id);
      const ph = st.reduce((a, p) => a + (p.photos?.length || 0), 0);
      const iss = st.filter(p => p.issue).length;
      const badges = [];
      if (sync && isDirty(s)) badges.push('<span class="badge wait">Waiting to sync</span>');
      if (s.public) badges.push('<span class="badge pub">Public</span>');
      if (expSoon(s)) badges.push(`<span class="badge exp">${expText(daysLeft(s))}</span>`);
      return `<button class="scard" data-id="${s.id}">
        <span class="sname">${esc(s.name || 'Untitled survey')}</span>
        <span class="smeta">${esc(fmtDate(s.createdAt, false))}${s.surveyor ? ' · ' + esc(s.surveyor) : ''}</span>
        <span class="scount"><b>${st.length}</b> stops · <b>${ph}</b> photos${iss ? ` · <b style="color:var(--issue)">${iss}</b> issue${iss === 1 ? '' : 's'}` : ''}${s.mapId ? '' : ' · no plan'}</span>
        ${badges.length ? `<span class="badges">${badges.join('')}</span>` : ''}</button>`;
    }).join('');
    L.querySelectorAll('.scard').forEach(b => (b.onclick = () => openSurvey(b.dataset.id)));
  }
  // Team surveys: public surveys of other people (from the last sync), plus any already downloaded
  const team = new Map((sync ? SYNC.team : []).map(m => [m.id, m]));
  for (const c of cached.values()) if (!team.has(c.id)) team.set(c.id, { id: c.id, owner: c.owner, name: c.name, updatedAt: Date.parse(c.updatedAt) || 0, cachedOnly: true });
  const T = $('teamList'), list = [...team.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('teamHead').hidden = !list.length; $('mineHead').hidden = !list.length;
  T.innerHTML = list.map(m => {
    const c = cached.get(m.id), st = c ? allStops.filter(p => p.surveyId === m.id) : null;
    const n = st ? st.length : m.stops, ph = st ? st.reduce((a, p) => a + (p.photos?.length || 0), 0) : m.photos;
    return `<button class="scard" data-id="${m.id}">
      <span class="sname">${esc(m.name || 'Untitled survey')}</span>
      <span class="smeta">Shared by ${esc(m.owner || 'a teammate')}${m.updatedAt ? ' · ' + esc(fmtDate(new Date(m.updatedAt).toISOString(), false)) : ''}</span>
      <span class="scount">${n != null ? `<b>${n}</b> stops · <b>${ph || 0}</b> photos` : ''}</span>
      <span class="badges">${c ? '<span class="badge">On this device</span>' : '<span class="badge wait">Tap to download</span>'}</span></button>`;
  }).join('');
  T.querySelectorAll('.scard').forEach(b => (b.onclick = () => openTeam(b.dataset.id)));
  $('exportAllBtn').hidden = S.surveys.length < 2;
  renderExpiry(); renderSyncLine(); renderStorage();
}
function renderExpiry() {
  const soon = S.surveys.filter(expSoon).sort((a, b) => a.expiresAt - b.expiresAt), B = $('expiryBanner');
  B.hidden = !soon.length; if (!soon.length) return;
  B.innerHTML = `<p><b class="t">${soon.length === 1 ? 'A survey is' : soon.length + ' surveys are'} about to be deleted.</b> Surveys are deleted from all devices ${SYNC.keepDays || 30} days after their last change. Keep the ones you still need, or build the report or export them first.</p>` +
    soon.map(s => `<div class="xrow"><span><b>${esc(s.name || 'Untitled survey')}</b> · ${expText(daysLeft(s))}</span><button class="btn" data-keep="${s.id}">Keep 30 more days</button></div>`).join('');
  B.querySelectorAll('[data-keep]').forEach(b => (b.onclick = () => keepSurvey(b.dataset.keep, b)));
}
async function openTeam(id) {
  if (await idb.has('surveys', id)) return openSurvey(id);
  const m = SYNC.team.find(x => x.id === id); if (!m) return;
  if (!navigator.onLine) return toast('Connect to the internet to download this survey. After that it works offline.', 4000);
  toast('Downloading the survey…', 60000);
  try { await pullSurvey(m, true); toast('Downloaded. It stays on this device for offline use.', 2500); openSurvey(id); }
  catch (e) { toast(e.code === 'signin' ? 'Sign in again to download it.' : 'Could not download it: ' + (e.message || e), 4000); if (e.code === 'signin') signinNeeded(); }
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
  S.selId = null; S.armed = false; S.moving = null; S.zoom = 1;
  const z = [...S.stops].reverse().find(p => p.zone); S.lastZone = z ? z.zone : '';
  if (!S.cur.readonly) migrateSheets(); else syncSheet();
  const ro = !!S.cur.readonly;
  document.body.classList.toggle('ro', ro);
  $('roBanner').hidden = !ro;
  if (ro) $('roBanner').innerHTML = `<p>Shared by <b>${esc(S.cur.owner || 'a teammate')}</b> · read-only. You can look through it and build the report.</p>`;
  $('svName').readOnly = ro; $('lbName').readOnly = ro;
  twoTap($('delSurvey'), ro ? 'Remove from this device' : 'Delete survey', ro ? 'Tap again to remove' : 'Tap again to delete for good', deleteSurveyAction);
  $('delHint').textContent = ro ? 'It stays available to the team. Open it from Team surveys to download it again.'
    : S.cur.remote ? 'Deleting removes the survey from all your devices and your account for good. Build and share the report first.'
    : 'Deleting removes the plan, stops and photos from this phone for good. Build and share the report first.';
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
  if (changed) touch(false);
}
function switchSheet(id) {
  if (!S.cur || S.cur.sheetId === id || !sheetById(id)) return;
  S.cur.sheetId = id; syncSheet(); S.zoom = 1; touch(false); renderSurvey();
  const sc = $('mapScroll'); if (sc) { sc.scrollLeft = 0; sc.scrollTop = 0; }
}

async function showList() { await flushSaves(); closeSheet(); S.moving = null; closeDetailDocs(); clearURLs(); S.cur = null; $('surveyView').classList.remove('split'); document.body.classList.remove('split-on', 'ro'); show('list'); await renderList(); scheduleSync(300); }
$('backBtn').onclick = showList;

function renderSurvey(full) {
  const s = S.cur; if (!s) return;
  if (full || document.activeElement !== $('svName')) $('svName').value = s.name || '';
  $('cStops').textContent = S.stops.length;
  $('cPhotos').textContent = S.stops.reduce((a, p) => a + (p.photos?.length || 0), 0);
  $('svSurveyor').textContent = s.surveyor ? 'Surveyor: ' + s.surveyor : '';
  renderIssueCount();
  const hasMap = !!s.mapId;
  $('actionBar').hidden = (!hasMap && !s.noMap) || !!s.readonly;
  $('surveyView').classList.toggle('split', hasMap);
  document.body.classList.toggle('split-on', hasMap);
  const mv = movingStop();
  $('addBtn').textContent = mv ? `Cancel moving stop ${mv.n}` : hasMap ? (S.armed ? 'Tap the plan… (cancel)' : '+ Drop pin') : '+ New stop';
  $('addBtn').classList.toggle('armed', S.armed || !!mv);
  $('addBtn').classList.toggle('primary', !S.armed && !mv);
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
    if (s.noMap || s.readonly) { P.hidden = true; return; }
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
    $('mapScroll').addEventListener('scroll', scheduleDetail, { passive: true });
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
  const mv = movingStop();
  inner.classList.toggle('armed', S.armed || !!mv);
  $('zLbl').textContent = (Math.round(S.zoom * 10) / 10) + '×';
  const h = $('mapHint');
  h.textContent = mv ? `Tap the new spot for stop ${mv.n}.${s.sheets.length > 1 ? ' Switch sheets above to move it to another sheet.' : ''}` : S.armed ? 'Tap the plan where you are standing.' : 'Pins mark each stop. Tap a pin to open it.';
  h.classList.toggle('live', S.armed || !!mv);
  inner.querySelectorAll('.pin').forEach(n => n.remove());
  for (const p of S.stops) {
    if (p.x == null || p.sheetId !== s.sheetId) continue;
    const b = document.createElement('button');
    b.className = 'pin' + (p.issue ? ' issue' : '') + (p.id === S.selId ? ' sel' : '') + (mv && p.id === mv.id ? ' moving' : '');
    b.style.left = (p.x * 100) + '%'; b.style.top = (p.y * 100) + '%';
    b.setAttribute('aria-label', 'Stop ' + p.n + (p.issue ? ' (issue)' : ''));
    b.innerHTML = `<span>${p.n}</span><i></i>`;
    b.onclick = (e) => { e.stopPropagation(); if (!S.armed && !S.moving && !justPinched()) openStop(p.id); };
    inner.appendChild(b);
  }
  if (S.zoom > zMax()) applyZoom(zMax());
  scheduleDetail();
}

/* ---------------- sharp zoom ----------------
   Each sheet is stored as a picture (about 4,000 px across) for the overview. Sheets loaded from a PDF also keep
   that page as a small PDF. Zoomed in past the picture's detail, the part of the plan on screen is redrawn from
   the PDF at screen sharpness, so room numbers and fine text stay crisp however far you zoom. */
const DETAIL = { docs: new Map(), task: null, t: 0, gen: 0 };
const DETAIL_MAX_PX = 6e6; // per redraw; keeps phones well inside their canvas memory limits
function scheduleDetail() { clearTimeout(DETAIL.t); DETAIL.t = setTimeout(renderDetail, 160); }
function dropCanvas(c) { if (!c) return; c.width = c.height = 0; c.remove(); } // frees the memory right away on iPhone
async function sheetPdfPage(sh) {
  let d = DETAIL.docs.get(sh.pdfId);
  if (!d) {
    for (const [k, v] of DETAIL.docs) { v.then(x => x.destroy()).catch(() => {}); DETAIL.docs.delete(k); } // keep one open
    d = idb.get('blobs', sh.pdfId).then(r => { if (!r) throw new Error('missing'); return pdfjsLib.getDocument({ data: new Uint8Array(r.buf.slice(0)) }).promise; });
    DETAIL.docs.set(sh.pdfId, d);
    d.catch(() => DETAIL.docs.delete(sh.pdfId));
  }
  return (await d).getPage(sh.pdfPage || 1);
}
function closeDetailDocs() { for (const v of DETAIL.docs.values()) v.then(x => x.destroy()).catch(() => {}); DETAIL.docs.clear(); }
async function renderDetail() {
  const gen = ++DETAIL.gen;
  const sh = S.cur && curSheet(), inner = $('mapInner'), sc = $('mapScroll');
  const old = inner && inner.querySelector('canvas.detail');
  if (!sh || !sh.pdfId || !inner || !sc || !window.pdfjsLib || $('mapPanel').dataset.mode !== 'map') { dropCanvas(old); return; }
  if (old && old.dataset.sheet !== sh.id) dropCanvas(old);
  const ir = inner.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  const iw = ir.width, ih = ir.height, dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (!iw || !ih || iw * dpr <= (sh.w || 0) * 1.05) { dropCanvas(inner.querySelector('canvas.detail')); return; } // the picture is sharp enough
  let x0 = Math.max(0, sr.left - ir.left), y0 = Math.max(0, sr.top - ir.top);
  let x1 = Math.min(iw, sr.right - ir.left), y1 = Math.min(ih, sr.bottom - ir.top);
  if (x1 - x0 < 2 || y1 - y0 < 2) return;
  // Draw a margin around the screen so small pans stay sharp, when that fits the budget
  const mx = (x1 - x0) * 0.25, my = (y1 - y0) * 0.25;
  const px0 = Math.max(0, x0 - mx), py0 = Math.max(0, y0 - my), px1 = Math.min(iw, x1 + mx), py1 = Math.min(ih, y1 + my);
  if ((px1 - px0) * (py1 - py0) * dpr * dpr <= DETAIL_MAX_PX) { x0 = px0; y0 = py0; x1 = px1; y1 = py1; }
  const area = (x1 - x0) * (y1 - y0);
  const k = Math.min(dpr, Math.sqrt(DETAIL_MAX_PX / area));
  const cur = inner.querySelector('canvas.detail');
  if (cur && Math.abs(+cur.dataset.iw - iw) < 1 && +cur.dataset.x0 <= Math.max(0, sr.left - ir.left) + 1 && +cur.dataset.y0 <= Math.max(0, sr.top - ir.top) + 1 &&
      +cur.dataset.x1 >= Math.min(iw, sr.right - ir.left) - 1 && +cur.dataset.y1 >= Math.min(ih, sr.bottom - ir.top) - 1) return; // already covers the screen
  try {
    const page = await sheetPdfPage(sh);
    if (gen !== DETAIL.gen) return;
    const v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (iw * k) / v1.width });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((x1 - x0) * k)); c.height = Math.max(1, Math.round((y1 - y0) * k));
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (DETAIL.task) { try { DETAIL.task.cancel(); } catch (_) {} }
    DETAIL.task = page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0 * k, -y0 * k] });
    await DETAIL.task.promise; DETAIL.task = null;
    if (gen !== DETAIL.gen || !inner.isConnected || curSheet()?.id !== sh.id) { dropCanvas(c); return; }
    c.className = 'detail';
    Object.assign(c.dataset, { sheet: sh.id, iw, x0, y0, x1, y1 });
    Object.assign(c.style, { left: (x0 / iw * 100) + '%', top: (y0 / ih * 100) + '%', width: ((x1 - x0) / iw * 100) + '%', height: ((y1 - y0) / ih * 100) + '%' });
    const prev = inner.querySelector('canvas.detail');
    inner.insertBefore(c, $('mapImg').nextSibling);
    dropCanvas(prev);
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    DETAIL.task = null; // anything else: stay on the picture, which is still usable
  }
}
window.addEventListener('resize', scheduleDetail);
/* Sheets that keep their PDF redraw sharp at any zoom, so they can zoom much further. */
const ZMIN = 1, zMax = () => (curSheet()?.pdfId ? 32 : 8);
function applyZoom(z) {
  S.zoom = Math.max(ZMIN, Math.min(zMax(), z));
  scheduleDetail();
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
  if ((!S.armed && !S.moving) || justPinched()) return;
  const r = $('mapInner').getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  if (S.moving) return finishMove(+x.toFixed(4), +y.toFixed(4));
  S.armed = false;
  createStop(+x.toFixed(4), +y.toFixed(4));
}
/* Move pin: the stop keeps all its data; only its spot (and sheet) changes. */
const movingStop = () => S.moving ? S.stops.find(p => p.id === S.moving) || null : null;
function startMove() {
  const p = sel(); if (!p || !S.cur.mapId) return;
  flushSaves();
  if (p.sheetId && S.cur.sheetId !== p.sheetId && sheetById(p.sheetId)) { S.cur.sheetId = p.sheetId; syncSheet(); touch(false); }
  S.moving = p.id; S.armed = false;
  closeSheet(); renderSurvey(); backToPlan();
}
async function finishMove(x, y) {
  const p = movingStop(); S.moving = null;
  if (!p) { renderSurvey(); return; }
  const was = p.x == null;
  p.x = x; p.y = y; p.sheetId = S.cur.sheetId;
  try { await saveStop(p); await touch(); toast(`Stop ${p.n} ${was ? 'placed on the plan' : 'moved'}`); }
  catch (e) { toast(storageMsg(e)); }
  renderSurvey();
}
function cancelMove() { S.moving = null; renderSurvey(); }
$('addBtn').onclick = () => {
  if (S.moving) return cancelMove();
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
      ${hasDims(p) ? `<span class="dim">${esc(dimsText(p))}</span>` : ''}
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
  $('shareBox').hidden = !SYNC.available || !!s.readonly;
  $('setPublic').checked = !!s.public;
  $('keepInfo').textContent = s.remote && s.expiresAt
    ? `Saved to your account. It will be deleted from all devices on ${fmtDate(new Date(s.expiresAt).toISOString(), false)}, ${SYNC.keepDays || 30} days after its last change, unless you change it or keep it.`
    : 'Not uploaded to your account yet. That happens automatically when there is a signal.';
  $('keepRow').hidden = !expSoon(s);
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
    await releaseSheetBlobs(sh, s.sheets);
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
$('setPublic').onchange = async () => {
  S.cur.public = $('setPublic').checked; await touch();
  toast(S.cur.public ? 'Public: the team will see it (read-only) once it syncs.' : 'Private: only you can see it now.', 3500);
};
$('keepBtn').onclick = () => keepSurvey(S.cur.id, $('keepBtn'));
$('replaceMap').onclick = () => { S.fileMode = S.cur.mapId ? 'replace' : 'add'; $('mapFile').click(); };
/* Remove a survey and everything it uses from this device. */
async function deleteLocal(id) {
  const s = await idb.get('surveys', id);
  const stops = await idb.byIndex('stops', 'surveyId', id);
  for (const p of stops) { for (const b of (p.photos || [])) { await idb.del('blobs', b); dropURL(b); } await idb.del('stops', p.id); }
  if (s) for (const b of new Set([s.mapId, ...(s.sheets || []).flatMap(sh => [sh.mapId, sh.pdfId])].filter(Boolean))) { await idb.del('blobs', b); dropURL(b); }
  await idb.del('surveys', id);
}
async function deleteSurveyAction() {
  const s = S.cur; if (!s) return;
  try {
    flushSaves();
    if (s.remote && !s.readonly) addPendingDelete(s.id);
    await deleteLocal(s.id);
    toast(s.readonly ? 'Removed from this device' : s.remote ? 'Survey deleted on all your devices' : 'Survey deleted');
    showList();
  } catch (e) { toast('Could not delete: ' + (e.message || e)); }
}
twoTap($('delSurvey'), 'Delete survey', 'Tap again to delete for good', deleteSurveyAction);

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
  if (S.cur?.readonly) return;
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
  const done = [];
  for (const [id, t] of pending) {
    clearTimeout(t); pending.delete(id);
    const st = S.stops.find(p => p.id === id); if (st) done.push(saveStop(st));
  }
  return Promise.all(done);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });
window.addEventListener('pagehide', flushSaves);

function openStop(id) { flushSaves(); const ps = S.stops.find(x => x.id === id); if (ps && ps.sheetId && S.cur.sheetId !== ps.sheetId && sheetById(ps.sheetId)) { S.cur.sheetId = ps.sheetId; syncSheet(); S.zoom = 1; touch(false); } S.selId = id; S.armed = false; renderSurvey(); openSheet(); }
function openSheet() { $('sheet').hidden = false; $('sheet').scrollTop = 0; document.body.classList.add('editing'); renderSheet(true); }
function closeSheet() { flushSaves(); $('sheet').hidden = true; document.body.classList.remove('editing'); S.selId = null; setTimeout(applyUpdate, 300); scheduleSync(1500); }
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
  for (const [k] of DIM_KEYS) { const el = $('sDim' + k.toUpperCase()); if (full || document.activeElement !== el) el.value = (p.dims && p.dims[k]) || ''; }
  const ph = p.photos || [];
  $('sPhotos').innerHTML = ph.map((id, i) => { const n = photoMarks(p, id).length; return `<button data-i="${i}" aria-label="Open photo ${i + 1}${n ? `, ${n} arrow${n === 1 ? '' : 's'}` : ''}"><img data-blob="${id}" alt="">${photoName(p, id) ? `<span class="cap">${esc(photoName(p, id))}</span>` : ''}${n ? `<span class="mk">↗${n > 1 ? n : ''}</span>` : ''}</button>`; }).join('');
  $('sPhotos').querySelectorAll('button').forEach(b => (b.onclick = () => openLightbox(+b.dataset.i)));
  hydrate($('sPhotos'));
  const zones = [...new Set(S.stops.map(x => x.zone).filter(Boolean))].filter(z => z !== p.zone).slice(-6);
  $('sChips').innerHTML = zones.map(z => `<button class="zchip" type="button">${esc(z)}</button>`).join('');
  $('sChips').querySelectorAll('.zchip').forEach((c, i) => (c.onclick = () => { $('sZone').value = zones[i]; setZone(zones[i]); }));
  renderGps(p);
  $('sIssue').checked = !!p.issue; $('sIssueBox').classList.toggle('on', !!p.issue);
  $('sMove').hidden = !S.cur.mapId;
  const ro = !!S.cur.readonly;
  for (const id of ['sZone', 'sNote', 'sDimW', 'sDimD', 'sDimH']) $(id).readOnly = ro;
  $('sIssue').disabled = ro; $('sChips').hidden = ro;
  $('sMove').textContent = p.x == null ? 'Place on plan' : 'Move pin';
  if (full) { $('sStatus').textContent = ''; $('sStatus').className = 'status'; $('sSaved').textContent = ''; }
}
function setZone(v) { const p = sel(); if (!p) return; p.zone = v; S.lastZone = v; schedule(p); renderStops(); }
$('sZone').addEventListener('input', e => setZone(e.target.value.trim()));
$('sNote').addEventListener('input', e => { const p = sel(); if (!p) return; p.note = e.target.value; schedule(p); });
$('sZone').addEventListener('blur', () => { flushSaves(); });
$('sNote').addEventListener('blur', () => { flushSaves(); renderStops(); });
for (const [k] of DIM_KEYS) {
  const el = $('sDim' + k.toUpperCase());
  el.addEventListener('input', () => {
    const p = sel(); if (!p) return;
    const v = el.value.trim(), d = { ...(p.dims || {}) };
    if (v) d[k] = v; else delete d[k];
    if (Object.keys(d).length) p.dims = d; else delete p.dims;
    schedule(p);
  });
  el.addEventListener('blur', () => { flushSaves(); renderStops(); });
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return; e.preventDefault();
    const next = { W: 'sDimD', D: 'sDimH' }[k.toUpperCase()];
    if (next) $(next).focus(); else el.blur();
  });
}

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

$('sMove').onclick = startMove;
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
async function addPdfPages(pdf, pages, labels, base, file) {
  const items = []; let k = 0;
  for (const n of pages) {
    k++; busy(pages.length > 1 ? `Preparing sheet ${k} of ${pages.length}…` : 'Preparing the sheet…');
    const r = await pdfSheetBlob(pdf, n);
    items.push({ ...r, name: (labels && labels[n - 1]) || (pdf.numPages > 1 ? `Page ${n}` : base), page: n });
  }
  if (file) {
    busy('Saving the sheets for sharp zoom…');
    const src = await pdfDetailSources(file, pages, pdf.numPages);
    for (const it of items) if (src[it.page]) { it.pdfBlob = src[it.page].blob; it.pdfPage = src[it.page].page; }
  }
  await applySheets(items);
}
/* pdf-lib (loaded only when a PDF plan is added) copies each picked page into its own small PDF.
   If that can't be done (for example a secured plan set), the whole file is kept once and shared by its sheets. */
let pdfLibP = null;
const loadPdfLib = () => pdfLibP || (pdfLibP = new Promise((res, rej) => {
  if (window.PDFLib) return res(window.PDFLib);
  const sc = document.createElement('script'); sc.src = 'vendor/pdf-lib.min.js';
  sc.onload = () => (window.PDFLib ? res(window.PDFLib) : rej(new Error('pdf-lib missing')));
  sc.onerror = () => { pdfLibP = null; rej(new Error('pdf-lib did not load')); };
  document.head.appendChild(sc);
}));
async function pdfDetailSources(file, pages, numPages) {
  const out = {};
  if (numPages === 1) { out[1] = { blob: new Blob([await file.arrayBuffer()], { type: 'application/pdf' }), page: 1 }; return out; }
  try {
    const L = await loadPdfLib();
    const src = await L.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
    if (src.isEncrypted) throw new Error('secured');
    for (const n of pages) {
      const d = await L.PDFDocument.create();
      const [pg] = await d.copyPages(src, [n - 1]); d.addPage(pg);
      out[n] = { blob: new Blob([await d.save()], { type: 'application/pdf' }), page: 1 };
    }
  } catch (_) {
    const whole = new Blob([await file.arrayBuffer()], { type: 'application/pdf' });
    for (const n of pages) out[n] = { blob: whole, page: n };
  }
  return out;
}
/* Delete a sheet's stored files unless another sheet in the survey still uses them (a shared plan-set PDF). */
async function releaseSheetBlobs(sh, others) {
  for (const id of [sh.mapId, sh.pdfId]) {
    if (!id || others.some(o => o.mapId === id || o.pdfId === id)) continue;
    try { await idb.del('blobs', id); } catch (_) {}
    dropURL(id); DETAIL.docs.delete(id);
  }
}
/* Add sheets to the survey, or replace the image of the current sheet. */
async function applySheets(items) {
  const s = S.cur;
  const pdfIds = new Map(); // one stored copy per PDF, even when several sheets share it
  const setPdf = async (sh, it) => {
    delete sh.pdfId; delete sh.pdfPage;
    if (!it.pdfBlob) return;
    if (!pdfIds.has(it.pdfBlob)) { let id = null; try { id = await putBlob(it.pdfBlob); } catch (_) {} pdfIds.set(it.pdfBlob, id); }
    const id = pdfIds.get(it.pdfBlob);
    if (id) { sh.pdfId = id; if (it.pdfPage > 1) sh.pdfPage = it.pdfPage; }
  };
  if (S.fileMode === 'replace' && curSheet() && items.length) {
    const sh = curSheet(), old = { mapId: sh.mapId, pdfId: sh.pdfId }, it = items[0];
    sh.mapId = await putBlob(it.blob); sh.w = it.w; sh.h = it.h;
    await setPdf(sh, it);
    await releaseSheetBlobs(old, s.sheets);
  } else {
    let firstId = null;
    for (const it of items) {
      const sh = { id: uid(), name: String(it.name || 'Sheet').slice(0, 40), mapId: await putBlob(it.blob), w: it.w, h: it.h };
      await setPdf(sh, it);
      s.sheets.push(sh); firstId = firstId || sh.id;
    }
    if (firstId) s.sheetId = firstId;
  }
  s.noMap = false; syncSheet(); await touch();
  const n = items.length, replaced = S.fileMode === 'replace';
  S.zoom = 1; S.fileMode = 'add'; S.sheetKey = ''; $('mapPanel').dataset.mode = ''; renderSurvey(true);
  toast(replaced ? 'Sheet replaced.' : n > 1 ? `${n} sheets added. Switch between them with the tabs above the plan.` : (s.sheets.length > 1 ? 'Sheet added.' : 'Plan loaded. Tap Drop pin to start.'), 4000);
}
async function pickSheets(pdf, labels, file) {
  const P = $('mapPanel'); P.hidden = false; P.dataset.mode = 'pick';
  const N = pdf.numPages, M = Math.min(N, 60), replace = S.fileMode === 'replace';
  P.innerHTML = `<div class="empty"><h2>${replace ? 'Pick the replacement sheet' : 'Pick the sheets'}</h2>
    <p class="sub">This PDF has ${N} pages${N > 60 ? ' (showing the first 60)' : ''}. ${replace ? 'Tap the page to use.' : 'Tap every page your walk covers, then tap Add.'}</p>
    <div class="sheets" id="sheetGrid"></div>
    <div class="row"><button class="btn primary" id="sheetAdd" ${replace ? 'hidden' : ''} disabled>Add sheets</button><button class="btn" id="sheetCancel">Cancel</button></div></div>`;
  const picked = new Set();
  $('sheetCancel').onclick = () => { P.dataset.mode = ''; S.fileMode = 'add'; renderSurvey(); };
  const go = async (pages) => {
    try { await addPdfPages(pdf, pages, labels, 'Sheet', file); }
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
      if (pdf.numPages === 1) await addPdfPages(pdf, [1], labels, base, f); else await pickSheets(pdf, labels, f);
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
      const dl = hasDims(p) ? doc.splitTextToSize(dimsText(p, true), CW - 44) : [];
      const h = 14 + zl.length * 13 + dl.length * 13 + nl.length * 13 + 14;
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
      if (dl.length) { doc.setTextColor(...MID); for (const l of dl) { doc.text(l, M + 38, y); y += 13; } doc.setTextColor(...BLACK); }
      for (const l of nl) { doc.text(l, M + 38, y); y += 13; }
      doc.setFontSize(8.5); doc.setTextColor(...MID);
      doc.text(`Stop ${p.n}${multi && sheetName(p.sheetId) ? ' · ' + sheetName(p.sheetId) : ''} · ${p.photos?.length || 0} photo${(p.photos?.length || 0) === 1 ? '' : 's'} · details below`, M + 38, y); 
      y = Math.max(y, top + h) + 8;
    }
    y += 16;
  }

  // Summary table
  sectionHead('Stop summary');
  const anyDims = stops.some(hasDims);
  const cols = [{ t: '#', w: 30 }, { t: 'Location', w: 0 }];
  if (multi) cols.push({ t: 'Sheet', w: 80 });
  if (anyDims) cols.push({ t: 'Room (W × D · Clg)', w: 104 });
  cols.push({ t: 'Notes', w: 0 }, { t: 'Photos', w: 46 });
  { const free = CW - cols.reduce((a, c) => a + c.w, 0); cols[1].w = Math.round(free * 0.38); cols[cols.length - 2].w = free - cols[1].w; }
  const cNote = cols.length - 2, cSheet = multi ? 2 : -1, cDim = anyDims ? (multi ? 3 : 2) : -1;
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
    const shl = multi ? doc.splitTextToSize(sheetName(p.sheetId) || '—', cols[cSheet].w - 14).slice(0, 3) : [];
    let dml = [];
    if (anyDims) {
      const d = p.dims || {}, t = [];
      if (d.w || d.d) t.push([d.w, d.d].map(v => v ? dimVal(v) : '?').join(' × '));
      if (d.h) t.push('Clg ' + dimVal(d.h));
      dml = t.length ? t.flatMap(x => doc.splitTextToSize(x, cols[cDim].w - 14)).slice(0, 3) : ['—'];
    }
    const rh = Math.max(zl.length, nl.length, shl.length, dml.length) * 11.5 + 11;
    if (ensure(rh)) head();
    if (p.issue) { doc.setFillColor(...RED_SOFT); doc.rect(M, y, CW, rh, 'F'); doc.setFillColor(...RED); doc.rect(M, y, 3, rh, 'F'); }
    else if (i % 2 === 0) { doc.setFillColor(...LO); doc.rect(M, y, CW, rh, 'F'); }
    doc.setDrawColor(...DIV); doc.setLineWidth(0.5); doc.line(M, y + rh, M + CW, y + rh);
    doc.setTextColor(...BLACK);
    let cx = M;
    doc.setFont('helvetica', 'bold'); if (p.issue) doc.setTextColor(...RED); doc.text(String(p.n), cx + 7, y + 15); cx += cols[0].w;
    doc.text(zl, cx + 7, y + 15, { lineHeightFactor: 1.28 }); doc.setTextColor(...BLACK); cx += cols[1].w;
    doc.setFont('helvetica', 'normal');
    if (multi) { doc.text(shl, cx + 7, y + 15, { lineHeightFactor: 1.28 }); cx += cols[cSheet].w; }
    if (anyDims) { doc.text(dml, cx + 7, y + 15, { lineHeightFactor: 1.28 }); cx += cols[cDim].w; }
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
    if (hasDims(p)) sub.push('Room: ' + dimsText(p, true));
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
    EXALL.ids = []; $('readyNext').hidden = true; $('readySave').hidden = false;
    $('readyTitle').textContent = 'Report ready';
    const mb = blob.size / 1048576;
    $('readyInfo').textContent = `${readyFile.name} · ${mb < 1 ? Math.round(blob.size / 1024) + ' KB' : mb.toFixed(1) + ' MB'}. Share it to Mail, Teams, Files or AirDrop. If you are offline, save it now and send it later.`;
    $('readyShare').hidden = !(navigator.canShare && navigator.canShare({ files: [readyFile] }));
    $('ready').hidden = false;
  } catch (e) { toast('Could not build the report: ' + (e.message || e), 5000); }
  finally { btn.textContent = label; btn.disabled = !S.stops.length; }
};
const readyList = () => (Array.isArray(readyFile) ? readyFile : readyFile ? [readyFile] : []);
$('readyShare').onclick = async () => {
  const files = readyList(); if (!files.length) return;
  try {
    await navigator.share({ files, title: files.length > 1 ? 'Site Walk surveys' : (S.cur?.name || 'Site walk') });
    if (EXALL.ids.length > EXALL.i) { $('readyShare').hidden = true; $('readyInfo').textContent = 'Saved. Tap Next batch for the rest.'; }
    else { $('ready').hidden = true; if (EXALL.ids.length) { toast('All surveys exported.', 3000); EXALL.ids = []; } }
  } catch (e) { if (e.name !== 'AbortError') toast('Sharing did not work here. Use Save / open instead.'); }
};
$('readySave').onclick = () => {
  readyList().forEach((f, k) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }, k * 700));
};
$('readyClose').onclick = () => { $('ready').hidden = true; readyFile = null; EXALL.ids = []; $('readyNext').hidden = true; setTimeout(applyUpdate, 300); };

/* Export all: one .sitewalk file per survey, handed over in batches (about 100 MB or 10 surveys at a time)
   so a phone never has to hold every survey in memory at once. */
const EXALL = { ids: [], i: 0, batch: 0 };
const fmtSize = n => n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
async function exportAllBatch() {
  const files = []; let size = 0; const from = EXALL.i;
  $('readyNext').hidden = true; $('readyShare').hidden = true; $('readySave').hidden = true;
  $('readyTitle').textContent = 'Packing surveys…'; $('ready').hidden = false;
  while (EXALL.i < EXALL.ids.length && files.length < 10 && size < 100 * 1048576) {
    $('readyInfo').textContent = `Packing survey ${EXALL.i + 1} of ${EXALL.ids.length}…`;
    const f = await exportSurvey(EXALL.ids[EXALL.i]); EXALL.i++;
    if (f) { files.push(f); size += f.size; }
  }
  EXALL.batch++;
  readyFile = files;
  const more = EXALL.i < EXALL.ids.length, total = EXALL.ids.length;
  $('readyTitle').textContent = more || EXALL.batch > 1 ? `Survey files ready (batch ${EXALL.batch})` : 'Survey files ready';
  $('readyInfo').textContent = `Surveys ${from + 1}–${EXALL.i} of ${total} · ${fmtSize(size)}. Tap Share… and choose Save to Files (or AirDrop). ` +
    (more ? 'Then tap Next batch for the rest.' : 'On the other device or app, tap Import and pick all of them at once.');
  $('readySave').hidden = false;
  $('readyShare').hidden = !(navigator.canShare && navigator.canShare({ files }));
  $('readyNext').hidden = !more;
}
$('exportAllBtn').onclick = async () => {
  await flushSaves();
  EXALL.ids = S.surveys.filter(s => !s.readonly).map(s => s.id); EXALL.i = 0; EXALL.batch = 0;
  if (!EXALL.ids.length) return;
  try { await exportAllBatch(); } catch (e) { $('ready').hidden = true; toast('Could not export: ' + (e.message || e), 5000); }
};
$('readyNext').onclick = async () => { try { await exportAllBatch(); } catch (e) { toast('Could not export: ' + (e.message || e), 5000); } };

/* ---------------- survey files (.sitewalk): move a survey between devices ----------------
   Layout: "SWALK1" · 4-byte little-endian header length · JSON header · raw image bytes back to back.
   Raw bytes (no base64) keep big surveys from running a phone out of memory. */
const SW_MAGIC = 'SWALK1';
const SYNC_FIELDS = ['owner', 'rev', 'seq', 'syncedSeq', 'remote', 'readonly', 'expiresAt'];
const stripSync = s => { const c = { ...s }; for (const k of SYNC_FIELDS) delete c[k]; return c; };
async function exportSurvey(id = S.cur?.id) {
  flushSaves();
  const s0 = S.cur && S.cur.id === id ? S.cur : await idb.get('surveys', id); if (!s0) return;
  const s = stripSync(s0);
  const stops = (await idb.byIndex('stops', 'surveyId', s.id)).sort((a, b) => a.n - b.n);
  const ids = [...new Set([s.mapId, ...(s.sheets || []).flatMap(sh => [sh.mapId, sh.pdfId]), ...stops.flatMap(p => p.photos || [])].filter(Boolean))];
  const index = [], parts = [];
  for (const id of ids) {
    const r = await idb.get('blobs', id); if (!r) continue;
    index.push({ id, type: r.type, size: r.buf.byteLength }); parts.push(r.buf);
  }
  const header = new TextEncoder().encode(JSON.stringify({ app: 'sitewalk', format: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), survey: s, stops, blobs: index }));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, header.length, true);
  const blob = new Blob([new TextEncoder().encode(SW_MAGIC), len, header, ...parts], { type: 'application/octet-stream' });
  const date = new Date().toISOString().slice(0, 10);
  const base = (s.name || 'site-walk').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'site-walk';
  return new File([blob], `${base}-${date}.sitewalk`, { type: 'application/octet-stream' });
}
$('exportBtn').onclick = async () => {
  const btn = $('exportBtn'); btn.disabled = true; btn.textContent = 'Packing the survey…';
  try {
    readyFile = await exportSurvey(); if (!readyFile) return;
    EXALL.ids = []; $('readyNext').hidden = true; $('readySave').hidden = false;
    const mb = readyFile.size / 1048576;
    $('readyTitle').textContent = 'Survey file ready';
    $('readyInfo').textContent = `${readyFile.name} · ${mb < 1 ? Math.round(readyFile.size / 1024) + ' KB' : mb.toFixed(1) + ' MB'}. AirDrop it, save it to Files or send it by email, then open Site Walk on the other device and tap Import on the Surveys screen.`;
    $('readyShare').hidden = !(navigator.canShare && navigator.canShare({ files: [readyFile] }));
    $('ready').hidden = false;
  } catch (e) { toast(storageMsg(e).replace('Could not save', 'Could not export'), 5000); }
  finally { btn.disabled = false; btn.textContent = 'Export survey file'; }
};

function parseSurveyFile(buf) {
  const bad = new Error('That is not a Site Walk survey file.');
  if (buf.byteLength < 10 || new TextDecoder().decode(new Uint8Array(buf, 0, 6)) !== SW_MAGIC) throw bad;
  const hl = new DataView(buf, 6, 4).getUint32(0, true);
  if (10 + hl > buf.byteLength) throw bad;
  let h; try { h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 10, hl))); } catch (_) { throw bad; }
  if (h.app !== 'sitewalk' || !h.survey?.id || !Array.isArray(h.stops) || !Array.isArray(h.blobs)) throw bad;
  if (h.format > 1) throw new Error('This file came from a newer version of Site Walk. Update the app on this device (open it with a signal), then import again.');
  return { h, start: 10 + hl };
}
/* mode: 'new' (not on this device yet), 'replace' (overwrite the copy here), 'copy' (keep both) */
async function importSurvey({ h, start }, buf, mode, copySuffix = ' (copy)') {
  const written = [], map = {};
  let off = start;
  try {
    for (const b of h.blobs) {
      if (off + b.size > buf.byteLength) throw new Error('The survey file is incomplete. Export it again.');
      const id = uid();
      await idb.put('blobs', { id, type: b.type || 'image/jpeg', buf: buf.slice(off, off + b.size) });
      written.push(id); map[b.id] = id; off += b.size;
    }
  } catch (e) { for (const id of written) { try { await idb.del('blobs', id); } catch (_) {} } throw e; }
  const m = id => map[id] || null;
  const rekey = o => { const r = {}; for (const [k, v] of Object.entries(o || {})) if (map[k]) r[map[k]] = v; return r; };
  const s = stripSync(JSON.parse(JSON.stringify(h.survey)));
  if (mode === 'copy') { s.id = uid(); s.name = (s.name || 'Untitled survey') + copySuffix; }
  s.sheets = (s.sheets || []).map(sh => { const r = { ...sh, mapId: m(sh.mapId) }; if (sh.pdfId && m(sh.pdfId)) r.pdfId = m(sh.pdfId); else { delete r.pdfId; delete r.pdfPage; } return r; }).filter(sh => sh.mapId);
  if (!s.sheets.some(sh => sh.id === s.sheetId)) s.sheetId = s.sheets[0]?.id || null;
  s.mapId = m(s.mapId); s.updatedAt = new Date().toISOString();
  const stops = h.stops.map(p0 => {
    const p = JSON.parse(JSON.stringify(p0));
    if (mode === 'copy') p.id = uid();
    p.surveyId = s.id;
    const ph = (p.photos || []), marks = p.marks, caps = p.captions;
    p.photos = ph.map(m).filter(Boolean);
    if (marks) { p.marks = rekey(marks); if (!Object.keys(p.marks).length) delete p.marks; }
    if (caps) { p.captions = rekey(caps); if (!Object.keys(p.captions).length) delete p.captions; }
    return p;
  });
  // Gather what the replaced copy used, so it can be cleared once the new one is in
  let oldStops = [], oldBlobs = [];
  if (mode === 'replace') {
    const old = await idb.get('surveys', s.id);
    oldStops = await idb.byIndex('stops', 'surveyId', s.id);
    oldBlobs = [...new Set([old?.mapId, ...((old?.sheets) || []).flatMap(sh => [sh.mapId, sh.pdfId]), ...oldStops.flatMap(p => p.photos || [])].filter(Boolean))];
  }
  try {
    for (const p of stops) await idb.put('stops', p);
    await idb.put('surveys', s);
  } catch (e) {
    if (mode !== 'replace') for (const p of stops) { try { await idb.del('stops', p.id); } catch (_) {} }
    for (const id of written) { try { await idb.del('blobs', id); } catch (_) {} }
    throw e;
  }
  const keep = new Set(stops.map(p => p.id));
  for (const p of oldStops) if (!keep.has(p.id)) { try { await idb.del('stops', p.id); } catch (_) {} }
  for (const id of oldBlobs) { try { await idb.del('blobs', id); } catch (_) {} dropURL(id); }
  return s;
}
let impPending = null;
async function runImport(mode) {
  const job = impPending; impPending = null; $('impAsk').hidden = true;
  if (!job) return;
  S.importing = true; toast('Importing the survey…', 60000);
  try {
    const s = await importSurvey(job.parsed, job.buf, mode);
    toast(`Imported “${s.name || 'Untitled survey'}”: ${job.parsed.h.stops.length} stops, ${job.parsed.h.stops.reduce((a, p) => a + (p.photos?.length || 0), 0)} photos.`, 4000);
    await renderList();
  } catch (e) { toast(storageMsg(e).replace('Could not save', 'Could not import'), 6000); }
  finally { S.importing = false; setTimeout(applyUpdate, 300); }
}
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const list = [...e.target.files]; e.target.value = ''; if (!list.length) return;
  if (list.length > 1) return importMany(list);
  const f = list[0];
  try {
    const buf = await f.arrayBuffer();
    const parsed = parseSurveyFile(buf);
    impPending = { buf, parsed };
    const here = await idb.get('surveys', parsed.h.survey.id);
    if (!here) return runImport('new');
    $('impAskInfo').innerHTML = `<b>${esc(here.name || 'Untitled survey')}</b> is already here (last changed ${esc(fmtDate(here.updatedAt))}). The file was exported ${esc(fmtDate(parsed.h.exportedAt))}.<br><br><b>Replace</b> swaps this device's copy for the file. <b>Keep both</b> adds the file as a separate survey.`;
    $('impAsk').hidden = false;
  } catch (err) { impPending = null; toast(err.message || String(err), 5000); }
};
/* Several files picked at once: add each survey that isn't on this device yet; skip ones already here. */
async function importMany(list) {
  S.importing = true; let added = 0, skipped = 0; const bad = [];
  try {
    for (let k = 0; k < list.length; k++) {
      toast(`Importing ${k + 1} of ${list.length}…`, 60000);
      try {
        const buf = await list[k].arrayBuffer(), parsed = parseSurveyFile(buf);
        if (await idb.has('surveys', parsed.h.survey.id)) { skipped++; continue; }
        await importSurvey(parsed, buf, 'new'); added++;
      } catch (err) {
        if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) { bad.push(list[k].name + ' (out of space)'); break; }
        bad.push(list[k].name);
      }
    }
    await renderList();
    toast(`Imported ${added} survey${added === 1 ? '' : 's'}.` + (skipped ? ` ${skipped} already on this device ${skipped === 1 ? 'was' : 'were'} skipped.` : '') + (bad.length ? ` Not imported: ${bad.join(', ')}.` : ''), 7000);
    if (added) scheduleSync(500);
  } finally { S.importing = false; setTimeout(applyUpdate, 300); }
}
$('impReplace').onclick = () => runImport('replace');
$('impCopy').onclick = () => runImport('copy');
$('impCancel').onclick = () => { impPending = null; $('impAsk').hidden = true; setTimeout(applyUpdate, 300); };

/* ---------------- sync ----------------
   Works only when the app is hosted with its sync server (_worker.js). Elsewhere (GitHub Pages) it stays off and
   the app is device-only, as before.
   Each survey keeps: owner, rev (the server version this copy is based on), seq (local edit counter) and
   syncedSeq (the seq last uploaded). A survey needs uploading while seq ≠ syncedSeq, or if it has never been
   uploaded. Uploads say which server version they were based on; if another device got there first, nothing is
   overwritten: this device's version is kept as a copy. */
const SYNC = { available: null, me: ls.get('sw.me', '') || null, keepDays: 30, running: null, again: false, last: 0, state: '', team: [], t: 0 };
try { SYNC.team = JSON.parse(ls.get('sw.team', '[]')) || []; } catch (_) {}
if (SYNC.me) SYNC.available = true; // known from an earlier session, so the status shows even offline
const isDirty = s => !s.readonly && (!s.remote || (s.seq || 0) !== (s.syncedSeq || 0));
const blobIdsOf = (sv, stops) => [...new Set([sv.mapId, ...(sv.sheets || []).flatMap(sh => [sh.mapId, sh.pdfId]), ...stops.flatMap(p => p.photos || [])].filter(Boolean))];
const pendingDeletes = () => { try { return JSON.parse(ls.get('sw.pendingDel', '[]')) || []; } catch (_) { return []; } };
function addPendingDelete(id) { const a = pendingDeletes(); if (!a.includes(id)) a.push(id); ls.set('sw.pendingDel', JSON.stringify(a)); }
function dropPendingDelete(id) { ls.set('sw.pendingDel', JSON.stringify(pendingDeletes().filter(x => x !== id))); }
async function api(path, opt = {}) {
  const r = await fetch('api/' + path, { credentials: 'include', redirect: 'manual', cache: 'no-store', ...opt });
  if (r.type === 'opaqueredirect' || r.status === 401) { const e = new Error('Sign-in expired'); e.code = 'signin'; throw e; }
  return r;
}
async function apiJSON(path, opt) {
  const r = await api(path, opt);
  if (!r.ok) { const e = new Error(`Server said ${r.status}`); e.status = r.status; try { e.body = await r.json(); } catch (_) {} throw e; }
  return r.json();
}
/* Update stored survey fields without counting it as an edit (keeps the open copy in step). */
async function patchSurvey(id, f) {
  const open = S.cur && S.cur.id === id;
  const r = open ? { ...S.cur } : await idb.get('surveys', id); if (!r) return;
  Object.assign(r, f); await idb.put('surveys', r);
  if (open) Object.assign(S.cur, f);
}
function scheduleSync(ms = 3000) {
  if (SYNC.available === false) return;
  clearTimeout(SYNC.t); SYNC.t = setTimeout(() => syncNow(), ms);
}
function signinNeeded() { SYNC.state = 'signin'; $('signinBanner').hidden = false; renderSyncLine(); }
function syncNow() {
  if (SYNC.running) { SYNC.again = true; return SYNC.running; }
  SYNC.running = (async () => {
    do { SYNC.again = false; await syncPass(); } while (SYNC.again && navigator.onLine);
  })().finally(() => { SYNC.running = null; renderSyncLine(); });
  renderSyncLine();
  return SYNC.running;
}
async function syncPass() {
  if (!navigator.onLine) { SYNC.state = 'offline'; return; }
  try {
    const r = await api('me');
    if (r.status === 404 || !(r.headers.get('content-type') || '').includes('json')) { SYNC.available = false; SYNC.state = ''; return; }
    if (!r.ok) {
      let j = {}; try { j = await r.json(); } catch (_) {}
      SYNC.available = true; SYNC.state = 'error';
      SYNC.error = j.error === 'not-configured' ? 'Sync isn’t set up on the server yet (database or storage not connected).'
        : j.error === 'signin-check-failed' ? 'The server couldn’t check your sign-in. Retrying soon.' : `Server problem (${r.status}). Retrying soon.`;
      scheduleSync(60000); return;
    }
    const me = await r.json();
    if (SYNC.me && SYNC.me !== me.email) SYNC.team = []; // someone else signed in on this device
    SYNC.me = me.email; SYNC.keepDays = me.keepDays || 30; SYNC.available = true; ls.set('sw.me', SYNC.me);
    $('signinBanner').hidden = true;
    SYNC.state = 'syncing'; renderSyncLine();
    let problems = 0;
    // 1. deletions made on this device
    for (const id of pendingDeletes()) {
      try { await apiJSON('surveys/' + id, { method: 'DELETE' }); dropPendingDelete(id); }
      catch (e) { if (e.code === 'signin') throw e; if (e.status === 403 || e.status === 404) dropPendingDelete(id); else problems++; }
    }
    // 2. upload changed surveys
    for (const sv of await idb.all('surveys')) {
      if (!isDirty(sv) || (sv.owner && sv.owner !== SYNC.me)) continue;
      try { await pushSurvey(sv.id); } catch (e) { if (e.code === 'signin') throw e; problems++; }
    }
    // 3. bring this device up to date
    const { surveys: remote } = await apiJSON('surveys');
    const local = new Map((await idb.all('surveys')).map(x => [x.id, x]));
    const gone = new Set(pendingDeletes());
    for (const m of remote) {
      if (gone.has(m.id)) continue;
      const l = local.get(m.id), open = S.cur && S.cur.id === m.id;
      try {
        if (m.owner === SYNC.me) {
          if (m.deleted) { if (l && !isDirty(l) && !open) await deleteLocal(m.id); continue; }
          if ((!l || (m.rev > (l.rev || 0) && !isDirty(l))) && !open) await pullSurvey(m, false);
          else if (l && l.remote && (l.expiresAt !== m.expiresAt || !!l.public !== m.public)) await patchSurvey(m.id, { expiresAt: m.expiresAt, public: m.public });
        } else if (l && l.readonly && m.rev > (l.rev || 0) && !open) await pullSurvey(m, true);
      } catch (e) { if (e.code === 'signin') throw e; problems++; }
    }
    // downloaded team surveys that are no longer shared
    const visible = new Set(remote.filter(m => !m.deleted).map(m => m.id));
    for (const l of local.values()) if (l.readonly && !visible.has(l.id) && !(S.cur && S.cur.id === l.id)) await deleteLocal(l.id);
    SYNC.team = remote.filter(m => !m.deleted && m.public && m.owner !== SYNC.me);
    ls.set('sw.team', JSON.stringify(SYNC.team));
    SYNC.last = Date.now(); SYNC.state = problems ? 'error' : 'ok'; SYNC.error = problems ? 'Some surveys didn’t sync. Retrying soon.' : '';
    if (problems) scheduleSync(60000);
  } catch (e) {
    if (e.code === 'signin') signinNeeded();
    else { SYNC.state = navigator.onLine ? 'error' : 'offline'; SYNC.error = 'Couldn’t reach the server. Retrying soon.'; scheduleSync(60000); }
  }
  if (!$('listView').hidden) await renderList();
  else if (S.cur) renderSettings();
}
async function pushSurvey(id) {
  const open = S.cur && S.cur.id === id;
  const sv = open ? { ...S.cur } : await idb.get('surveys', id);
  const stops = (await idb.byIndex('stops', 'surveyId', id)).sort((a, b) => a.n - b.n);
  const seq = sv.seq || 0;
  const body = JSON.stringify({ baseRev: sv.rev || 0, doc: { survey: stripSync(sv), stops } });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await api('surveys/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    if (r.ok) {
      const j = await r.json();
      await patchSurvey(id, { owner: SYNC.me, rev: j.rev, syncedSeq: seq, remote: true, expiresAt: j.expiresAt });
      return;
    }
    if (r.status === 412) { // upload the files the server doesn't have yet
      const { missing } = await r.json();
      for (const b of missing) {
        const rec = await idb.get('blobs', b);
        if (!rec) throw new Error('a file is missing on this device');
        const u = await api(`files/${id}/${b}`, { method: 'PUT', headers: { 'content-type': rec.type || 'application/octet-stream' }, body: rec.buf });
        if (!u.ok) throw new Error(`file upload failed (${u.status})`);
      }
      continue;
    }
    if (r.status === 409) { await keepConflictCopy(id, await r.json().catch(() => ({}))); return; }
    throw new Error(`upload failed (${r.status})`);
  }
  throw new Error('upload did not complete');
}
/* Another device changed (or deleted) this survey since this device last synced: keep this device's version as a copy. */
async function keepConflictCopy(id, info) {
  const wasOpen = S.cur && S.cur.id === id;
  if (wasOpen) await flushSaves();
  const f = await exportSurvey(id), buf = await f.arrayBuffer();
  const orig = await idb.get('surveys', id);
  const copy = await importSurvey(parseSurveyFile(buf), buf, 'copy', ' (copy from this device)');
  if (wasOpen) await showList();
  if (info.deleted) await deleteLocal(id);
  else await patchSurvey(id, { syncedSeq: orig?.seq || 0 }); // the other device's version comes down next
  SYNC.again = true;
  toast(`“${orig?.name || 'Survey'}” was ${info.deleted ? 'deleted' : 'also changed'} on another device. This device’s version was saved as “${copy.name}”.`, 7000);
  if (wasOpen) openSurvey(copy.id);
}
async function pullSurvey(m, readonly) {
  const { meta, doc } = await apiJSON('surveys/' + m.id);
  const ids = blobIdsOf(doc.survey, doc.stops);
  for (const b of ids) {
    if (await idb.has('blobs', b)) continue;
    const r = await api(`files/${m.id}/${b}`);
    if (!r.ok) throw new Error(`a file could not be downloaded (${r.status})`);
    await idb.put('blobs', { id: b, type: r.headers.get('content-type') || 'application/octet-stream', buf: await r.arrayBuffer() });
  }
  const local = await idb.get('surveys', m.id);
  const oldStops = await idb.byIndex('stops', 'surveyId', m.id);
  const oldIds = local ? blobIdsOf(local, oldStops) : [];
  for (const p of doc.stops) await idb.put('stops', { ...p, surveyId: m.id });
  const keepStops = new Set(doc.stops.map(p => p.id));
  for (const p of oldStops) if (!keepStops.has(p.id)) await idb.del('stops', p.id);
  const seq = local?.seq || 0;
  const sv = { ...doc.survey, id: m.id, owner: meta.owner, rev: meta.rev, remote: true, readonly: !!readonly, public: meta.public, expiresAt: meta.expiresAt, seq, syncedSeq: seq,
    updatedAt: new Date(meta.updatedAt).toISOString() };
  if (local && local.sheetId && (sv.sheets || []).some(sh => sh.id === local.sheetId)) sv.sheetId = local.sheetId;
  const sh = (sv.sheets || []).find(x => x.id === sv.sheetId) || (sv.sheets || [])[0];
  if (sh) { sv.sheetId = sh.id; sv.mapId = sh.mapId; sv.mapW = sh.w; sv.mapH = sh.h; }
  await idb.put('surveys', sv);
  const keep = new Set(ids);
  for (const b of oldIds) if (!keep.has(b)) { try { await idb.del('blobs', b); } catch (_) {} dropURL(b); }
}
async function keepSurvey(id, btn) {
  if (!navigator.onLine) return toast('Connect to the internet to keep it.', 3000);
  if (btn) btn.disabled = true;
  try {
    const j = await apiJSON(`surveys/${id}/keep`, { method: 'POST' });
    await patchSurvey(id, { expiresAt: j.expiresAt });
    toast(`Kept until ${fmtDate(new Date(j.expiresAt).toISOString(), false)}.`);
  } catch (e) {
    if (e.code === 'signin') signinNeeded();
    else if (e.status === 404) { toast('It hasn’t synced yet. It will be kept automatically when it does.', 4000); scheduleSync(200); }
    else toast('Could not keep it: ' + (e.message || e), 4000);
  }
  if (btn) btn.disabled = false;
  if (!$('listView').hidden) renderList(); else if (S.cur) renderSettings();
}
function renderSyncLine() {
  const line = $('syncLine'); if (!line) return;
  if (!SYNC.available) { line.hidden = true; $('listSub').textContent = 'Saved on this phone. Works without a signal.'; return; }
  line.hidden = false;
  $('listSub').textContent = 'Saved on this device and synced to your account.';
  const waiting = (S.surveys || []).filter(isDirty).length + pendingDeletes().length;
  const who = SYNC.me ? ` · ${SYNC.me}` : '';
  let t;
  if (SYNC.running && SYNC.state !== 'signin') t = 'Syncing…';
  else if (SYNC.state === 'signin') t = 'Sign in to sync.';
  else if (!navigator.onLine || SYNC.state === 'offline') t = waiting ? `Offline · ${waiting} change${waiting === 1 ? '' : 's'} waiting` : 'Offline · all changes saved here';
  else if (SYNC.state === 'error') t = SYNC.error || 'Couldn’t sync.';
  else if (waiting) t = `${waiting} change${waiting === 1 ? '' : 's'} waiting to sync`;
  else if (SYNC.last) t = `Synced ${new Date(SYNC.last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  else t = 'Ready to sync';
  $('syncText').textContent = t + who;
  line.classList.toggle('err', SYNC.state === 'error' || SYNC.state === 'signin');
  $('syncNowBtn').hidden = !!SYNC.running || !navigator.onLine;
}
$('syncNowBtn').onclick = () => syncNow();
window.addEventListener('online', () => scheduleSync(500));
window.addEventListener('offline', renderSyncLine);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(800); });

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

/* Team sign-in (when the app is hosted behind a sign-in such as Cloudflare Access).
   The app opens from the phone's cache, so an expired sign-in never shows by itself; it only blocks updates.
   A request that gets redirected means the sign-in has expired; offer a button to sign in again. */
async function checkSignin() {
  try {
    const r = await fetch('sw.js?signin-check=' + Date.now(), { cache: 'no-store', redirect: 'manual', credentials: 'include' });
    $('signinBanner').hidden = !(r.type === 'opaqueredirect' || r.status === 401 || r.status === 403);
  } catch (_) { /* offline or blocked: leave it */ }
}
$('signinGo').onclick = () => { flushSaves(); location.href = './?signin=' + Date.now(); };
/* After signing in, drop the ?signin marker from the address */
if (/[?&]signin=/.test(location.search)) history.replaceState(null, '', location.pathname);

/* Updates: check for a new version on launch and every time the app comes back to the foreground
   (home-screen apps on iPhone usually resume rather than restart). When a new version takes over,
   reload into it right away, or as soon as the open stop / photo / report window is closed. */
const busyEditing = () => !!S.moving || !$('sheet').hidden || !$('lb').hidden || !$('ready').hidden || !$('impAsk').hidden || S.importing || $('mapPanel').dataset.mode === 'pick' || $('mapPanel').dataset.mode === 'busy';
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
    const check = () => { if (navigator.onLine) { reg.update().catch(() => {}); checkSignin(); } };
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
openDB().then(renderList).then(() => scheduleSync(300)).catch(e => {
  $('surveyList').innerHTML = `<div class="emptycard"><h3>Storage is not available</h3><p>This browser is blocking on-device storage (${esc(e && e.message || e)}). On iPhone, open the app from the Home Screen or a normal Safari tab, not a private tab.</p></div>`;
});
