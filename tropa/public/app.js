'use strict';
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let me = null;   // текущий пользователь
let map = null;  // активная карта Leaflet
let draft = null; // трек, ожидающий сохранения: { points, source }

async function api(path, body, method = body ? 'POST' : 'GET') {
  const r = await fetch('/api' + path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Ошибка сервера');
  return j;
}

// ---------- форматирование ----------
const km = (m) => (m < 1000 ? Math.round(m) + ' м' : (m / 1000).toFixed(1).replace('.', ',') + ' км');
const dur = (s) => (s == null ? '—' : (s >= 3600 ? Math.floor(s / 3600) + ' ч ' : '') + Math.round((s % 3600) / 60) + ' мин');
const date = (t) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const stars = (r) => '★'.repeat(Math.round(r)) + '☆'.repeat(5 - Math.round(r));
const DIFF = { easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный' };
const SRC = { app: 'Записан в Тропе', apple: 'Apple Watch', google: 'Google Карты', strava: 'Strava', garmin: 'Garmin', other: 'Трекер' };

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const trackLen = (pts) => pts.reduce((d, p, i) => (i ? d + haversine(pts[i - 1], p) : 0), 0);

function thumb(preview) {
  const k = Math.cos((preview[0][0] * Math.PI) / 180);
  const xs = preview.map((p) => p[1] * k), ys = preview.map((p) => -p[0]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const s = 80 / Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0, 1e-9);
  const ox = (96 - (Math.max(...xs) - x0) * s) / 2, oy = (76 - (Math.max(...ys) - y0) * s) / 2;
  const d = preview.map((_, i) => `${(ox + (xs[i] - x0) * s).toFixed(1)},${(oy + (ys[i] - y0) * s).toFixed(1)}`).join(' ');
  return `<svg class="thumb" viewBox="0 0 96 76" aria-hidden="true"><polyline points="${d}"/></svg>`;
}

function routeCard(r) {
  return `<a class="card route" href="#/route/${r.id}">
    ${r.cover ? `<div class="thumb" style="background-image:url('${esc(r.cover)}')"></div>` : thumb(r.preview)}
    <div>
      <h3>${esc(r.title)}</h3>
      <div class="muted">${esc(r.region)}${r.region ? ' · ' : ''}${esc(r.author)}</div>
      <div class="stats">
        <span><b>${km(r.distance_m)}</b></span><span>↑ <b>${Math.round(r.ascent_m)} м</b></span><span>${dur(r.duration_s)}</span>
      </div>
      <div class="stats">
        <span class="badge ${r.difficulty}">${DIFF[r.difficulty]}</span>
        ${r.public ? '' : '<span class="badge private">Только я</span>'}
        ${r.reviews ? `<span><span class="stars" aria-hidden="true">${stars(r.rating)}</span> ${r.rating.toFixed(1)} · отзывов: ${r.reviews}</span>` : '<span>Пока без отзывов</span>'}
        ${r.notes ? `<span>пометок: ${r.notes}</span>` : ''}
      </div>
    </div></a>`;
}

function postCard(p) {
  return `<article class="card post">
    <header><a href="#/u/${p.user_id}">${esc(p.author)}</a>
      <span class="muted">${p.route && !p.text ? 'прошёл(ла) маршрут · ' : ''}${date(p.created)}
      ${me?.id === p.user_id && !(p.route && !p.text) ? ` <button class="link" data-del-post="${p.id}">удалить</button>` : ''}</span></header>
    ${p.text ? `<div class="text">${esc(p.text)}</div>` : ''}
    ${p.photo ? `<img src="${esc(p.photo)}" alt="Фото к записи" loading="lazy">` : ''}
    ${p.route ? routeCard(p.route) : ''}
  </article>`;
}

// Фото уменьшаем на клиенте и всегда отправляем JPEG — сервер принимает только его.
function readPhoto(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => rej(new Error('Не удалось прочитать фото'));
    img.src = URL.createObjectURL(file);
  });
}
const photoOf = (data) => (data.photo && data.photo.size ? readPhoto(data.photo) : null);

function onSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form), err = $('.err', form);
    btn.disabled = true; err.textContent = '';
    try { await fn(Object.fromEntries(new FormData(form))); } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false;
  });
}

function mkMap(el, points) {
  map = L.map(el, { scrollWheelZoom: false });
  // shortcut: публичные тайлы OSM годятся для старта; при росте трафика нужен свой тайл-провайдер
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  if (points?.length) {
    const ll = points.map((p) => [p[0], p[1]]);
    const line = L.polyline(ll, { color: '#e8732c', weight: 4 }).addTo(map);
    L.circleMarker(ll[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#1f5c3f', fillOpacity: 1 }).addTo(map).bindTooltip('Старт');
    L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#1d2a22', fillOpacity: 1 }).addTo(map).bindTooltip('Финиш');
    map.fitBounds(line.getBounds(), { padding: [24, 24], animate: false });
  } else map.setView([52.3, 104.3], 5);
  return map;
}
const pin = () => L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [28, 28], iconAnchor: [14, 28] });

// ---------- импорт трека из файла трекера ----------
function parseTrack(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Файл не читается. Нужен GPX или KML.');
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  // GPX
  let pts = [...doc.querySelectorAll('trkpt, rtept')].map((p) => [
    num(p.getAttribute('lat')), num(p.getAttribute('lon')), num($('ele', p)?.textContent), Date.parse($('time', p)?.textContent) || null]);
  // KML с временем (gx:Track), затем обычная линия
  if (!pts.length) {
    const whens = [...doc.getElementsByTagName('when')].map((w) => Date.parse(w.textContent) || null);
    pts = [...doc.getElementsByTagName('gx:coord')].map((c, i) => {
      const [lng, lat, ele] = c.textContent.trim().split(/\s+/).map(num);
      return [lat, lng, ele ?? null, whens[i] ?? null];
    });
  }
  if (!pts.length) {
    pts = [...doc.querySelectorAll('LineString > coordinates')].flatMap((c) => c.textContent.trim().split(/\s+/).map((s) => {
      const [lng, lat, ele] = s.split(',').map(num);
      return [lat, lng, ele ?? null, null];
    }));
  }
  pts = pts.filter((p) => p[0] != null && p[1] != null);
  if (pts.length < 2) throw new Error('В файле не найден трек.');
  return thin(pts);
}
function thin(pts) { // сервер принимает до 5000 точек
  const step = Math.ceil(pts.length / 5000);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

// ---------- запись трека в браузере ----------
// Точки пишутся в localStorage на каждом шаге: перезагрузка страницы не теряет поход.
// shortcut: браузер перестаёт отдавать GPS при погашенном экране; для фоновой записи нужно нативное приложение.
const rec = { watch: null, lock: null, pts: JSON.parse(localStorage.getItem('tropa_rec') || '[]') };
function recStart() {
  rec.watch = navigator.geolocation.watchPosition((pos) => {
    const c = pos.coords;
    if (c.accuracy > 50) return;
    const p = [c.latitude, c.longitude, c.altitude, pos.timestamp];
    const last = rec.pts[rec.pts.length - 1];
    if (last && haversine(last, p) < 5) return;
    rec.pts.push(p);
    localStorage.setItem('tropa_rec', JSON.stringify(rec.pts));
    recPaint();
  }, (err) => {
    recStop();
    add(err.code === 1 ? 'Нет доступа к геопозиции. Разрешите его в настройках браузера.' : 'Не удалось получить геопозицию.');
  }, { enableHighAccuracy: true, maximumAge: 5000 });
  navigator.wakeLock?.request('screen').then((l) => (rec.lock = l)).catch(() => {});
}
function recStop() {
  if (rec.watch != null) navigator.geolocation.clearWatch(rec.watch);
  rec.lock?.release();
  rec.watch = rec.lock = null;
}
function recClear() { rec.pts = []; localStorage.removeItem('tropa_rec'); }
function recPaint() {
  const el = $('#rec-stat');
  if (el) el.textContent = `${km(trackLen(rec.pts))} · точек: ${rec.pts.length}`;
}

// ---------- экраны ----------
async function explore() {
  app.innerHTML = `
    <section class="hero"><h1>Куда пойдём?</h1><p>Маршруты с отзывами и подсказками тех, кто их уже прошёл.</p></section>
    <label>Поиск по месту или названию<input type="search" id="q" placeholder="Байкал, Хамар-Дабан, Алтай…" autocomplete="off"></label>
    <div class="map small" id="map"></div>
    <div id="list"></div>`;
  mkMap($('#map'));
  const layer = L.layerGroup().addTo(map);
  const load = async () => {
    const list = await api('/routes?q=' + encodeURIComponent($('#q').value));
    $('#list').innerHTML = list.map(routeCard).join('') || '<p class="empty">Ничего не нашли. Пройдите этот маршрут первым и расскажите о нём!</p>';
    layer.clearLayers();
    list.forEach((r) => L.marker(r.preview[0], { icon: pin(), title: r.title }).addTo(layer).on('click', () => (location.hash = '#/route/' + r.id)));
    if (list.length) map.fitBounds(list.map((r) => r.preview[0]), { padding: [30, 30], maxZoom: 11, animate: false });
  };
  let timer;
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  await load();
}

async function feed() {
  const posts = await api('/feed');
  app.innerHTML = `<h1>Лента</h1>${posts.map(postCard).join('') || '<p class="empty">Пока тихо. Загрузите первый трек!</p>'}`;
}

async function routeView(id) {
  const r = await api('/routes/' + id);
  const mine = me?.id === r.user_id;
  const myReview = r.reviewList.find((v) => v.user_id === me?.id);
  app.innerHTML = `
    <h1>${esc(r.title)}</h1>
    <div class="stats">
      <span class="badge ${r.difficulty}">${DIFF[r.difficulty]}</span>
      ${r.public ? '' : '<span class="badge private">Только я</span>'}
      <span>${esc(r.region)}</span>
      <span>автор: <a href="#/u/${r.user_id}">${esc(r.author)}</a></span>
      <span>${date(r.created)} · ${SRC[r.source]}</span>
    </div>
    <div class="big-stats">
      <div><b>${km(r.distance_m)}</b><span>дистанция</span></div>
      <div><b>${Math.round(r.ascent_m)} м</b><span>набор высоты</span></div>
      <div><b>${dur(r.duration_s)}</b><span>в пути</span></div>
    </div>
    <div class="map" id="map"></div>
    <div class="actions">
      <button id="share">Поделиться</button>
      <button class="ghost" id="gpx">Скачать GPX</button>
      ${mine ? '<button class="ghost" id="del">Удалить маршрут</button>' : ''}
    </div>
    ${r.descr ? `<p class="text">${esc(r.descr)}</p>` : ''}

    <h2>Пометки на маршруте (${r.noteList.length})</h2>
    ${me ? `<p class="muted" id="note-hint">Нажмите на карту в нужном месте, чтобы оставить пометку или фото: вода, стоянка, опасный участок.</p>
      <form class="card" id="note-form" hidden>
        <label>Что здесь важно знать?<textarea name="text" maxlength="1000"></textarea></label>
        <label>Фото с этого места<input type="file" name="photo" accept="image/*"></label>
        <p class="err" role="alert"></p><button type="submit">Сохранить пометку</button>
      </form>` : '<p class="muted"><a href="#/login">Войдите</a>, чтобы оставлять пометки и фото.</p>'}
    ${r.noteList.map((n, i) => `<div class="card note" id="note-${n.id}">
        <b>${i + 1}.</b> <span class="text">${esc(n.text)}</span>
        ${n.photo ? `<img src="${esc(n.photo)}" alt="Фото с маршрута" loading="lazy">` : ''}
        <div class="muted"><a href="#/u/${n.user_id}">${esc(n.author)}</a> · ${date(n.created)}
        ${me && (me.id === n.user_id || mine) ? ` <button class="link" data-del-note="${n.id}">удалить</button>` : ''}</div>
      </div>`).join('')}

    <h2>Отзывы и подсказки ${r.reviews ? `· <span class="stars" aria-hidden="true">${stars(r.rating)}</span> ${r.rating.toFixed(1)}` : ''}</h2>
    ${r.reviewList.map((v) => `<div class="card"><span class="stars" aria-label="Оценка ${v.rating} из 5">${stars(v.rating)}</span>
        <p class="text">${esc(v.text)}</p><div class="muted"><a href="#/u/${v.user_id}">${esc(v.author)}</a> · ${date(v.created)}</div></div>`).join('') || '<p class="muted">Отзывов пока нет.</p>'}
    ${me && !mine ? `<form class="card" id="review-form">
        <label>Ваша оценка<select name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${myReview?.rating === n ? 'selected' : ''}>${stars(n)} (${n})</option>`).join('')}</select></label>
        <label>Отзыв и подсказка для тех, кто пойдёт следом<textarea name="text" maxlength="2000" required>${esc(myReview?.text)}</textarea></label>
        <p class="err" role="alert"></p><button type="submit">${myReview ? 'Обновить отзыв' : 'Оставить отзыв'}</button>
      </form>` : ''}`;

  mkMap($('#map'), r.points);
  r.noteList.forEach((n, i) => L.marker([n.lat, n.lng], { icon: pin(), title: n.text }).addTo(map)
    .bindPopup(`<b>${i + 1}.</b> ${esc(n.text)}`).on('click', () => $('#note-' + n.id).scrollIntoView({ behavior: 'smooth', block: 'center' })));

  $('#share').onclick = async (e) => {
    const data = { title: r.title, text: 'Маршрут в Тропе: ' + r.title, url: location.href };
    if (navigator.share) return navigator.share(data).catch(() => {});
    await navigator.clipboard.writeText(location.href);
    e.target.textContent = 'Ссылка скопирована';
  };
  $('#gpx').onclick = () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Тропа" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(r.title)}</name><trkseg>\n` +
      r.points.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}${p[3] != null ? `<time>${new Date(p[3]).toISOString()}</time>` : ''}</trkpt>`).join('\n') +
      '\n</trkseg></trk></gpx>';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
    a.download = `tropa-${r.id}.gpx`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  if (mine) $('#del').onclick = async () => {
    if (!confirm('Удалить маршрут вместе с пометками и отзывами?')) return;
    await api('/routes/' + id, null, 'DELETE');
    location.hash = '#/me/routes';
  };
  if (me) {
    let pending = null;
    map.on('click', (e) => {
      pending?.remove();
      pending = L.marker(e.latlng, { icon: pin(), opacity: 0.7 }).addTo(map);
      $('#note-form').hidden = false;
      $('#note-form textarea').focus();
    });
    onSubmit($('#note-form'), async (d) => {
      if (!pending) throw new Error('Сначала выберите место на карте');
      const { lat, lng } = pending.getLatLng();
      await api(`/routes/${id}/notes`, { lat, lng, text: d.text, photo: await photoOf(d) });
      router();
    });
  }
  if ($('#review-form')) onSubmit($('#review-form'), async (d) => {
    await api(`/routes/${id}/reviews`, { rating: Number(d.rating), text: d.text });
    router();
  });
}

async function add(message = '') {
  if (!me) return auth('Войдите, чтобы сохранять маршруты.');
  if (draft) return saveForm();
  const recording = rec.watch != null;
  app.innerHTML = `<h1>Новый маршрут</h1>
    <p class="err" role="alert">${esc(message)}</p>
    ${recording || rec.pts.length ? `
    <div class="card rec">
      <p>${recording ? '<span class="dot"></span><b>Идёт запись трека</b>' : '<b>Есть несохранённая запись</b>'}</p>
      <p id="rec-stat" class="stats" style="justify-content:center"></p>
      <div class="actions" style="justify-content:center">
        ${recording ? '' : '<button id="rec-go">Продолжить запись</button>'}
        <button class="accent" id="rec-done">Завершить и сохранить</button>
        <button class="ghost" id="rec-drop">Удалить запись</button>
      </div>
      <p class="muted">Держите экран включённым: браузер не записывает GPS в фоне.</p>
    </div>` : `
    <div class="card">
      <h2 style="margin-top:0">Синхронизировать с трекером</h2>
      <p class="muted">Закончили поход с Apple Watch, Garmin, Strava или Google Картами? Загрузите файл трека — Тропа сама построит маршрут, посчитает дистанцию, время и набор высоты.</p>
      <label>Откуда трек<select id="src">${['apple', 'google', 'strava', 'garmin', 'other'].map((s) => `<option value="${s}">${SRC[s]}</option>`).join('')}</select></label>
      <label style="margin-top:10px">Файл GPX или KML<input type="file" id="file" accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml"></label>
      <details><summary>Где взять файл?</summary><ul>
        <li><b>Apple Watch:</b> приложение «Здоровье» → профиль → «Экспортировать медданные». В архиве папка <i>workout-routes</i> с файлами GPX.</li>
        <li><b>Google Карты:</b> «Мои карты» → меню карты → «Экспортировать в KML/KMZ» (выберите KML).</li>
        <li><b>Strava:</b> откройте тренировку на сайте → «…» → «Экспорт GPX».</li>
        <li><b>Garmin Connect:</b> тренировка → шестерёнка → «Экспорт в GPX».</li>
      </ul></details>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Записать прямо сейчас</h2>
      <p class="muted">Включите трекер в начале пути. Тропа попросит доступ к геопозиции и будет записывать маршрут, пока вы идёте.</p>
      <button class="accent" id="rec-go">Начать запись</button>
    </div>`}`;
  recPaint();
  const go = $('#rec-go');
  if (go) go.onclick = () => {
    if (!navigator.geolocation) return add('Этот браузер не умеет определять геопозицию.');
    recStart();
    add();
  };
  if ($('#rec-done')) {
    $('#rec-done').onclick = () => {
      if (rec.pts.length < 2) return add('Пока записано меньше двух точек — пройдите немного дальше.');
      recStop();
      draft = { points: thin(rec.pts), source: 'app', recorded: true };
      add();
    };
    $('#rec-drop').onclick = () => { if (confirm('Удалить записанный трек?')) { recStop(); recClear(); add(); } };
  }
  if ($('#file')) $('#file').onchange = async (e) => {
    try {
      draft = { points: parseTrack(await e.target.files[0].text()), source: $('#src').value };
      add();
    } catch (ex) { add(ex.message); }
  };
}

function saveForm() {
  app.innerHTML = `<h1>Сохранить маршрут</h1>
    <div class="stats"><span><b>${km(trackLen(draft.points))}</b></span><span>точек: ${draft.points.length}</span><span>${SRC[draft.source]}</span></div>
    <div class="map small" id="map"></div>
    <form id="f">
      <label>Название<input type="text" name="title" required minlength="2" maxlength="100" placeholder="Например: Пик Черского из Слюдянки"></label>
      <label>Регион или место<input type="text" name="region" maxlength="80" placeholder="Байкал, Иркутская область"></label>
      <label>Сложность<select name="difficulty">${Object.entries(DIFF).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label>Описание и советы<textarea name="descr" maxlength="3000" placeholder="Где вода, где стоянки, что взять с собой"></textarea></label>
      <label class="row"><input type="checkbox" name="public" checked> Показывать всем и опубликовать на моей стене</label>
      <p class="err" role="alert"></p>
      <div class="actions"><button type="submit">Сохранить</button><button type="button" class="ghost" id="cancel">Отмена</button></div>
    </form>`;
  mkMap($('#map'), draft.points);
  $('#cancel').onclick = () => { draft = null; add(); };
  onSubmit($('#f'), async (d) => {
    const { id } = await api('/routes', { ...d, public: d.public === 'on', points: draft.points, source: draft.source });
    if (draft.recorded) recClear(); // запись стираем только после успешного сохранения
    draft = null;
    location.hash = '#/route/' + id;
  });
}

async function profile(id, tab = 'wall') {
  const u = await api('/users/' + id);
  const self = me?.id === u.id;
  const total = u.routes.reduce((s, r) => s + r.distance_m, 0), up = u.routes.reduce((s, r) => s + r.ascent_m, 0);
  app.innerHTML = `
    <h1>${esc(u.name)}</h1>
    <p class="text">${esc(u.bio) || (self ? '<span class="muted">Расскажите о себе — какие походы любите.</span>' : '')}</p>
    <div class="big-stats">
      <div><b>${u.routes.length}</b><span>маршрутов</span></div>
      <div><b>${km(total)}</b><span>пройдено</span></div>
      <div><b>${Math.round(up)} м</b><span>набрано</span></div>
    </div>
    ${self ? '<div class="actions"><button class="ghost" id="bio">Изменить «о себе»</button><button class="ghost" id="out">Выйти</button></div>' : ''}
    <div class="seg" role="tablist">
      <button role="tab" aria-selected="${tab !== 'routes'}" data-tab="wall">Стена</button>
      <button role="tab" aria-selected="${tab === 'routes'}" data-tab="routes">Маршруты</button>
    </div>
    ${tab === 'routes'
      ? (self ? '<div class="actions"><a class="btn accent" href="#/add" style="background:var(--accent)">+ Добавить маршрут</a></div>' : '') +
        (u.routes.map(routeCard).join('') || '<p class="empty">Маршрутов пока нет.</p>')
      : (self ? `<form class="card" id="post-form">
          <label>Что нового в походной жизни?<textarea name="text" maxlength="2000"></textarea></label>
          <label>Фото<input type="file" name="photo" accept="image/*"></label>
          ${u.routes.length ? `<label>Прикрепить маршрут<select name="route_id"><option value="">— без маршрута —</option>${u.routes.filter((r) => r.public).map((r) => `<option value="${r.id}">${esc(r.title)}</option>`).join('')}</select></label>` : ''}
          <p class="err" role="alert"></p><button type="submit">Опубликовать</button></form>` : '') +
        (u.posts.map(postCard).join('') || '<p class="empty">На стене пока пусто.</p>')}`;
  app.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => (location.hash = `#/u/${u.id}/${b.dataset.tab}`)));
  if (!self) return;
  $('#out').onclick = async () => { await api('/logout', {}); me = null; paintWho(); location.hash = '#/'; };
  $('#bio').onclick = async () => {
    const bio = prompt('О себе (до 300 символов)', u.bio);
    if (bio == null) return;
    try { await api('/me', { bio }); router(); } catch (ex) { alert(ex.message); }
  };
  if ($('#post-form')) onSubmit($('#post-form'), async (d) => {
    await api('/posts', { text: d.text, route_id: Number(d.route_id) || null, photo: await photoOf(d) });
    router();
  });
}

function auth(message = '', mode = 'login') {
  const reg = mode === 'register';
  app.innerHTML = `
    <section class="hero"><h1>Тропа</h1><p>Сохраняйте пройденные маршруты, делитесь ими и выбирайте новые по отзывам туристов.</p></section>
    ${message ? `<p>${esc(message)}</p>` : ''}
    <div class="seg" role="tablist">
      <button role="tab" aria-selected="${!reg}" id="to-login">Вход</button>
      <button role="tab" aria-selected="${reg}" id="to-reg">Регистрация</button>
    </div>
    <form id="f" class="card">
      ${reg ? '<label>Имя<input type="text" name="name" required minlength="2" maxlength="40" autocomplete="name"></label>' : ''}
      <label>Email<input type="email" name="email" required autocomplete="email"></label>
      <label>Пароль${reg ? ' (минимум 8 символов)' : ''}<input type="password" name="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
      <p class="err" role="alert"></p><button type="submit">${reg ? 'Создать аккаунт' : 'Войти'}</button>
    </form>`;
  $('#to-login').onclick = () => auth(message, 'login');
  $('#to-reg').onclick = () => auth(message, 'register');
  onSubmit($('#f'), async (d) => {
    me = await api(reg ? '/register' : '/login', d);
    paintWho();
    if (location.hash === '#/login' || location.hash === '#/me') location.hash = '#/me/routes'; else router();
  });
}

// ---------- роутер ----------
function paintWho() {
  $('#who').innerHTML = me ? `<a href="#/me">${esc(me.name)}</a>` : '<a href="#/login">Войти</a>';
}
async function router() {
  map?.remove();
  map = null;
  const [name, a, b] = location.hash.replace(/^#\/?/, '').split('/');
  const tab = { '': 'explore', route: 'explore', feed: 'feed', add: 'add', me: 'me', login: 'me', u: Number(a) === me?.id ? 'me' : '' }[name];
  document.querySelectorAll('.tabs a').forEach((el) => el.classList.toggle('on', el.dataset.tab === tab));
  try {
    if (name === 'route') await routeView(Number(a));
    else if (name === 'feed') await feed();
    else if (name === 'add') await add();
    else if (name === 'login') me ? await profile(me.id) : auth();
    else if (name === 'me') me ? await profile(me.id, a) : auth();
    else if (name === 'u') await profile(Number(a), b);
    else await explore();
  } catch (ex) {
    app.innerHTML = `<p class="empty">${esc(ex.message)}<br><a href="#/">На главную</a></p>`;
  }
  window.scrollTo(0, 0);
}

app.addEventListener('click', async (e) => {
  const post = e.target.dataset.delPost, note = e.target.dataset.delNote;
  if (!post && !note) return;
  if (!confirm('Удалить?')) return;
  try { await api(post ? '/posts/' + post : '/notes/' + note, null, 'DELETE'); router(); } catch (ex) { alert(ex.message); }
});
window.addEventListener('hashchange', router);
api('/me').then((r) => { me = r.user; }).catch(() => {}).finally(() => { paintWho(); router(); });
