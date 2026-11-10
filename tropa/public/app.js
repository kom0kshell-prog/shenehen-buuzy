'use strict';
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEMO = !!window.TROPA_DEMO; // демо без сервера: данные в памяти вкладки (demo-api.js)
const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;

let me = null;    // текущий пользователь
let map = null;   // активная карта Leaflet
let draft = null; // трек, ожидающий сохранения: { points, source }
let stopFx = null; // остановка анимации «пролёта» при уходе со страницы

async function api(path, body, method = body ? 'POST' : 'GET') {
  if (DEMO) return window.demoApi(path, body, method);
  const r = await fetch('api' + path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Ошибка сервера');
  return j;
}

// ---------- форматирование ----------
const num = (v, d = 1) => v.toFixed(d).replace('.', ',');
const km = (m) => (m < 1000 ? Math.round(m) + ' м' : num(m / 1000) + ' км');
const FMT = { km, m: (v) => Math.round(v) + ' м', n: (v) => String(Math.round(v)) };
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
const cumulative = (pts) => pts.reduce((acc, p, i) => (acc.push(i ? acc[i - 1] + haversine(pts[i - 1], p) : 0), acc), []);
const trackLen = (pts) => cumulative(pts).pop();

// ---------- движение ----------
function countUp(root = app) {
  if (CALM) return;
  root.querySelectorAll('[data-cu]').forEach((el) => {
    const to = Number(el.dataset.cu), f = FMT[el.dataset.f], t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1200);
      el.textContent = f(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
// пейзаж сдвигается слоями вслед за курсором или пальцем
function parallax(el) {
  const set = (x, y) => { const s = $('.scene', el); if (s) { s.style.setProperty('--px', x); s.style.setProperty('--py', y); } };
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    set(((e.clientX - r.left) / r.width - 0.5).toFixed(3), ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  });
  el.addEventListener('pointerleave', () => set(0, 0));
}
// вместо confirm(): первое нажатие «взводит» кнопку, второе подтверждает
function armed(btn) {
  if (btn.classList.contains('armed')) return true;
  const label = btn.textContent;
  btn.textContent = 'Точно удалить?';
  btn.classList.add('armed');
  setTimeout(() => { btn.textContent = label; btn.classList.remove('armed'); }, 3500);
  return false;
}

// ---------- общие блоки ----------
function squiggle(preview) {
  const k = Math.cos((preview[0][0] * Math.PI) / 180);
  const xs = preview.map((p) => p[1] * k), ys = preview.map((p) => -p[0]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  const s = 60 / Math.max(w, h, 1e-9), ox = (72 - w * s) / 2, oy = (54 - h * s) / 2;
  const d = preview.map((_, i) => `${(ox + (xs[i] - x0) * s).toFixed(1)},${(oy + (ys[i] - y0) * s).toFixed(1)}`).join(' ');
  return `<svg class="line" viewBox="0 0 72 54" aria-hidden="true"><polyline points="${d}"/></svg>`;
}
const cover = (r, key) => (r.cover ? '' : TropaScene(r.id, { h: 560, layers: 4, key }));

function routeCard(r) {
  return `<a class="rcard" href="#route-${r.id}" data-route="${r.id}">
    <div class="cover" ${r.cover ? `style="background-image:url('${esc(r.cover)}')"` : ''}>${cover(r, 'c')}
      <span class="badge ${r.difficulty}">${DIFF[r.difficulty]}</span>${squiggle(r.preview)}</div>
    <div class="rbody">
      <div class="eyebrow">${esc(r.region) || 'Маршрут'}${r.public ? '' : ' · только я'}</div>
      <h3>${esc(r.title)}</h3>
      <dl class="readout">
        <div><dt>Дистанция</dt><dd>${km(r.distance_m)}</dd></div>
        <div><dt>Набор</dt><dd>↑ ${Math.round(r.ascent_m)} м</dd></div>
        <div><dt>В пути</dt><dd>${dur(r.duration_s)}</dd></div>
      </dl>
      <div class="rfoot">
        <span>${r.reviews ? `<span class="stars" aria-hidden="true">★</span> ${num(r.rating)} · отзывов: ${r.reviews}` : 'Пока без отзывов'}${r.notes ? ` · пометок: ${r.notes}` : ''}</span>
        <span>${esc(r.author)}</span>
      </div>
    </div></a>`;
}

function postCard(p) {
  const auto = p.route && !p.text;
  return `<article class="post">
    <header><a href="#u-${p.user_id}">${esc(p.author)}</a>
      <span class="muted">${auto ? 'маршрут пройден · ' : ''}${date(p.created)}
      ${me?.id === p.user_id && !auto ? ` <button class="link" data-del-post="${p.id}">удалить</button>` : ''}</span></header>
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
  if (DEMO) window.demoRelief().addTo(map);
  else {
    // shortcut: публичные тайлы годятся для старта; при росте трафика нужен свой тайл-провайдер
    const plain = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM · © OpenTopoMap (CC-BY-SA)' });
    L.control.layers({ 'Схема': plain, 'Рельеф': topo }).addTo(map);
  }
  if (points?.length) {
    const ll = points.map((p) => [p[0], p[1]]);
    L.polyline(ll, { color: '#fff', weight: 8, opacity: 0.9 }).addTo(map);
    const line = L.polyline(ll, { color: '#d9583f', weight: 4 }).addTo(map);
    L.circleMarker(ll[0], { radius: 7, color: '#fff', weight: 3, fillColor: '#1f4d43', fillOpacity: 1 }).addTo(map).bindTooltip('Старт');
    L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 3, fillColor: '#13212a', fillOpacity: 1 }).addTo(map).bindTooltip('Финиш');
    map.fitBounds(line.getBounds(), { padding: [28, 28], animate: false });
  } else map.setView([52.3, 104.3], 5);
  return map;
}
const pin = () => L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [28, 28], iconAnchor: [14, 28] });

// ---------- импорт трека из файла трекера ----------
function parseTrack(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Файл не читается. Нужен GPX или KML.');
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  // GPX
  let pts = [...doc.querySelectorAll('trkpt, rtept')].map((p) => [
    n(p.getAttribute('lat')), n(p.getAttribute('lon')), n($('ele', p)?.textContent), Date.parse($('time', p)?.textContent) || null]);
  // KML с временем (gx:Track), затем обычная линия
  if (!pts.length) {
    const whens = [...doc.getElementsByTagName('when')].map((w) => Date.parse(w.textContent) || null);
    pts = [...doc.getElementsByTagName('gx:coord')].map((c, i) => {
      const [lng, lat, ele] = c.textContent.trim().split(/\s+/).map(n);
      return [lat, lng, ele ?? null, whens[i] ?? null];
    });
  }
  if (!pts.length) {
    pts = [...doc.querySelectorAll('LineString > coordinates')].flatMap((c) => c.textContent.trim().split(/\s+/).map((s) => {
      const [lng, lat, ele] = s.split(',').map(n);
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
const store = {
  get: () => { try { return JSON.parse(localStorage.getItem('tropa_rec') || '[]'); } catch { return []; } },
  set: (v) => { try { v ? localStorage.setItem('tropa_rec', JSON.stringify(v)) : localStorage.removeItem('tropa_rec'); } catch { /* хранилище недоступно */ } },
};
const rec = { watch: null, lock: null, pts: store.get() };
function recStart() {
  rec.watch = navigator.geolocation.watchPosition((pos) => {
    const c = pos.coords;
    if (c.accuracy > 50) return;
    const p = [c.latitude, c.longitude, c.altitude, pos.timestamp];
    const last = rec.pts[rec.pts.length - 1];
    if (last && haversine(last, p) < 5) return;
    rec.pts.push(p);
    store.set(rec.pts);
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
function recClear() { rec.pts = []; store.set(null); }
function recPaint() {
  const el = $('#rec-stat');
  if (el) el.textContent = `${km(trackLen(rec.pts) || 0)} · точек: ${rec.pts.length}`;
}

// ---------- экраны ----------
async function explore() {
  app.innerHTML = `
    <section class="scenic hero live">${TropaScene(7, { mood: 'dawn', trail: true, h: 680 })}
      <div class="wrap">
        <div class="eyebrow">Соцсеть туристических маршрутов</div>
        <h1>Маршруты, которые уже <em>кто-то прошёл</em></h1>
        <p>Треки с часов и телефона, пометки о воде и стоянках, отзывы тех, кто вернулся с тропы.</p>
        <form class="search" id="search" role="search">
          <input id="q" type="search" placeholder="Байкал, Хамар-Дабан, Алтай…" autocomplete="off" aria-label="Поиск по месту или названию">
          <button type="submit" class="accent">Найти</button>
        </form>
        <dl class="totals" id="totals"></dl>
      </div>
    </section>
    <div class="wrap explore">
      <div>
        <div class="filters" id="filters">
          <button class="chip" data-d="" aria-pressed="true">Все</button>
          ${Object.entries(DIFF).map(([k, v]) => `<button class="chip" data-d="${k}" aria-pressed="false">${v}</button>`).join('')}
          <select id="sort" aria-label="Сортировка"><option value="new">Сначала новые</option><option value="top">По рейтингу</option><option value="short">Сначала короткие</option></select>
        </div>
        <div class="list" id="list"></div>
      </div>
      <div class="map" id="map"></div>
    </div>`;
  parallax($('.hero'));
  mkMap($('#map'));
  const layer = L.layerGroup().addTo(map);
  let list = [], diff = '', first = true;
  const paint = () => {
    const sort = { new: (a, b) => b.created - a.created, top: (a, b) => (b.rating || 0) - (a.rating || 0), short: (a, b) => a.distance_m - b.distance_m }[$('#sort').value];
    const shown = list.filter((r) => !diff || r.difficulty === diff).sort(sort);
    $('#list').innerHTML = shown.map(routeCard).join('') || '<p class="empty">Ничего не нашли. Пройдите этот маршрут первым и расскажите о нём.</p>';
    layer.clearLayers();
    const marks = {};
    shown.forEach((r) => (marks[r.id] = L.marker(r.preview[0], { icon: pin(), title: r.title }).addTo(layer).on('click', () => (location.hash = '#route-' + r.id))));
    if (shown.length) map.fitBounds(shown.map((r) => r.preview[0]), { padding: [40, 40], maxZoom: 11, animate: false });
    // наведение на карточку подсвечивает метку и показывает линию трека на карте
    let ghost = null;
    $('#list').querySelectorAll('.rcard').forEach((card) => {
      const r = shown.find((x) => x.id === Number(card.dataset.route)), el = () => $('.pin', marks[r.id].getElement());
      card.onpointerenter = () => { el()?.classList.add('hot'); ghost = L.polyline(r.preview, { color: '#13212a', weight: 3, dashArray: '2 7' }).addTo(layer); };
      card.onpointerleave = () => { el()?.classList.remove('hot'); ghost?.remove(); };
    });
  };
  const load = async () => {
    list = await api('/routes?q=' + encodeURIComponent($('#q').value));
    if (first) {
      first = false;
      $('#totals').innerHTML = `
        <div><dd data-cu="${list.length}" data-f="n">${list.length}</dd><dt>маршрутов</dt></div>
        <div><dd data-cu="${list.reduce((s, r) => s + r.distance_m, 0)}" data-f="km">${km(list.reduce((s, r) => s + r.distance_m, 0))}</dd><dt>троп</dt></div>
        <div><dd data-cu="${list.reduce((s, r) => s + r.notes, 0)}" data-f="n">${list.reduce((s, r) => s + r.notes, 0)}</dd><dt>пометок с пути</dt></div>`;
      countUp();
    }
    paint();
  };
  let timer;
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  $('#search').addEventListener('submit', (e) => { e.preventDefault(); load(); $('#list').scrollIntoView({ behavior: CALM ? 'auto' : 'smooth', block: 'start' }); });
  $('#sort').onchange = paint;
  $('#filters').addEventListener('click', (e) => {
    if (!e.target.classList.contains('chip')) return;
    diff = e.target.dataset.d;
    $('#filters').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === e.target)));
    paint();
  });
  await load();
}

async function feed() {
  const posts = await api('/feed');
  app.innerHTML = `<div class="wrap narrow"><div class="eyebrow">Что нового на тропах</div><h1>Лента</h1>
    <div style="margin-top:22px">${posts.map(postCard).join('') || '<p class="empty">Пока тихо. Загрузите первый трек.</p>'}</div></div>`;
}

async function routeView(id) {
  const r = await api('/routes/' + id);
  const mine = me?.id === r.user_id;
  const myReview = r.reviewList.find((v) => v.user_id === me?.id);
  const pts = r.points, cum = cumulative(pts), total = cum[cum.length - 1] || 1;
  const nearest = (lat, lng) => pts.reduce((best, p, i) => (haversine(p, [lat, lng]) < haversine(pts[best], [lat, lng]) ? i : best), 0);
  const notes = r.noteList.map((n) => ({ ...n, at: cum[nearest(n.lat, n.lng)] })).sort((a, b) => a.at - b.at);

  // профиль высот: пропуски высоты заполняем соседним значением
  const hasEle = pts.filter((p) => p[2] != null).length > 1;
  let last = pts.find((p) => p[2] != null)?.[2] ?? 0;
  const ele = pts.map((p) => (last = p[2] ?? last));
  const lo = Math.min(...ele), hi = Math.max(...ele), span = hi - lo || 1;
  const xy = pts.map((_, i) => `${((cum[i] / total) * 1000).toFixed(1)} ${(190 - ((ele[i] - lo) / span) * 170).toFixed(1)}`);

  app.innerHTML = `
    <section class="scenic rhero live">${r.cover ? `<img class="photo" src="${esc(r.cover)}" alt="">` : TropaScene(r.id, { h: 680, key: 'h' })}
      <div class="wrap">
        <p class="meta"><span class="badge ${r.difficulty}">${DIFF[r.difficulty]}</span>${r.public ? '' : '<span class="badge private">Только я</span>'}
          <span>${esc(r.region)}</span><span>${date(r.created)} · ${SRC[r.source]}</span><span>автор: <a href="#u-${r.user_id}">${esc(r.author)}</a></span></p>
        <h1>${esc(r.title)}</h1>
        <dl class="totals">
          <div><dd data-cu="${r.distance_m}" data-f="km">${km(r.distance_m)}</dd><dt>дистанция</dt></div>
          <div><dd data-cu="${r.ascent_m}" data-f="m">${Math.round(r.ascent_m)} м</dd><dt>набор высоты</dt></div>
          <div><dd>${dur(r.duration_s)}</dd><dt>в пути</dt></div>
          ${r.reviews ? `<div><dd>★ ${num(r.rating)}</dd><dt>отзывов: ${r.reviews}</dt></div>` : ''}
        </dl>
      </div>
    </section>
    <div class="wrap narrow">
      <div class="map" id="map"></div>
      <div class="profile" id="profile">
        <header><span class="eyebrow">${hasEle ? 'Профиль высот' : 'Ход маршрута'}</span>
          <button class="ghost" id="play" aria-pressed="false" style="white-space:nowrap">▶ Пройти маршрут</button></header>
        <div class="plot" id="plot">
          <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
            <path class="area" d="M0 200L${xy.join('L')}L1000 200Z"/><path class="edge" d="M${xy.join('L')}"/></svg>
          ${notes.map((n) => `<i class="tick" style="left:${((n.at / total) * 100).toFixed(2)}%"></i>`).join('')}
          <div class="cursor" id="cursor" hidden></div>
        </div>
        <div class="axis"><span>0 км${hasEle ? ` · ${Math.round(ele[0])} м` : ''}</span>${hasEle ? `<span>мин ${Math.round(lo)} м · макс ${Math.round(hi)} м</span>` : ''}<span>${km(total)}</span></div>
      </div>
      <div class="actions">
        <button id="share">Поделиться</button>
        ${DEMO ? '' : '<button class="ghost" id="gpx">Скачать GPX</button>'}
        ${mine ? '<button class="ghost" id="del">Удалить маршрут</button>' : ''}
      </div>
      ${r.descr ? `<p class="text" style="font-size:1.08rem;max-width:40em">${esc(r.descr)}</p>` : ''}

      <h2>Пометки с пути</h2>
      ${me ? `<p class="muted" id="note-hint">Нажмите на карту в нужном месте, чтобы оставить пометку или фото: вода, стоянка, опасный участок.</p>
        <form class="panel" id="note-form" hidden>
          <label for="note-text">Что здесь важно знать?<textarea id="note-text" name="text" maxlength="1000"></textarea></label>
          <label for="note-photo">Фото с этого места<input id="note-photo" type="file" name="photo" accept="image/*"></label>
          <p class="err" role="alert"></p><button type="submit">Сохранить пометку</button>
        </form>` : '<p class="muted"><a href="#login">Войдите</a>, чтобы оставлять пометки и фото.</p>'}
      ${notes.length ? `<ol class="timeline">${notes.map((n) => `<li id="note-${n.id}">
          <div class="km">${num(n.at / 1000)} км</div>
          <div class="text">${esc(n.text)}</div>
          ${n.photo ? `<img src="${esc(n.photo)}" alt="Фото с маршрута" loading="lazy">` : ''}
          <div class="muted"><a href="#u-${n.user_id}">${esc(n.author)}</a> · ${date(n.created)}
          ${me && (me.id === n.user_id || mine) ? ` <button class="link" data-del-note="${n.id}">удалить</button>` : ''}</div>
        </li>`).join('')}</ol>` : '<p class="muted">Пометок пока нет.</p>'}

      <h2>Отзывы и подсказки</h2>
      ${r.reviewList.map((v) => `<div class="review"><span class="stars" aria-label="Оценка ${v.rating} из 5">${stars(v.rating)}</span>
          <p class="text">${esc(v.text)}</p><div class="muted"><a href="#u-${v.user_id}">${esc(v.author)}</a> · ${date(v.created)}</div></div>`).join('') || '<p class="muted">Отзывов пока нет.</p>'}
      ${me && !mine ? `<form class="panel" id="review-form" style="margin-top:22px">
          <fieldset class="rate"><legend>Ваша оценка</legend>
            ${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" id="rate-${n}" value="${n}" ${(myReview?.rating || 5) === n ? 'checked' : ''}><label for="rate-${n}">★<span class="sr">${n} из 5</span></label>`).join('')}
          </fieldset>
          <label for="review-text">Подсказка для тех, кто пойдёт следом<textarea id="review-text" name="text" maxlength="2000" required>${esc(myReview?.text)}</textarea></label>
          <p class="err" role="alert"></p><button type="submit">${myReview ? 'Обновить отзыв' : 'Оставить отзыв'}</button>
        </form>` : ''}
    </div>`;

  parallax($('.rhero'));
  countUp();
  mkMap($('#map'), pts);
  notes.forEach((n) => L.marker([n.lat, n.lng], { icon: pin(), title: n.text }).addTo(map)
    .bindPopup(`<b>${num(n.at / 1000)} км</b> ${esc(n.text)}`).on('click', () => $('#note-' + n.id).scrollIntoView({ behavior: CALM ? 'auto' : 'smooth', block: 'center' })));

  // курсор профиля и «турист» на карте движутся вместе
  const cursor = $('#cursor'), plot = $('#plot');
  const walker = L.marker([pts[0][0], pts[0][1]], { icon: L.divIcon({ className: '', html: '<div class="walker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, opacity: 0 }).addTo(map);
  const seek = (f) => {
    f = Math.min(1, Math.max(0, f));
    const d = f * total;
    let i = cum.findIndex((c) => c >= d);
    if (i < 1) i = 1;
    const k = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1), a = pts[i - 1], b = pts[i];
    walker.setOpacity(1).setLatLng([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    cursor.hidden = false;
    cursor.style.left = f * 100 + '%';
    cursor.classList.toggle('flip', f > 0.7);
    cursor.dataset.label = num(d / 1000) + ' км' + (hasEle ? ' · ' + Math.round(ele[i - 1] + (ele[i] - ele[i - 1]) * k) + ' м' : '');
  };
  let raf = 0;
  const halt = () => { cancelAnimationFrame(raf); raf = 0; $('#play').textContent = '▶ Пройти маршрут'; $('#play').setAttribute('aria-pressed', 'false'); };
  const drag = (e) => { halt(); const b = plot.getBoundingClientRect(); seek((e.clientX - b.left) / b.width); };
  plot.addEventListener('pointermove', drag);
  plot.addEventListener('pointerdown', drag);
  $('#play').onclick = () => {
    if (raf) return halt();
    const t0 = performance.now();
    $('#play').textContent = '❚❚ Пауза';
    $('#play').setAttribute('aria-pressed', 'true');
    const step = (t) => { const f = (t - t0) / 9000; seek(f); raf = f < 1 ? requestAnimationFrame(step) : (halt(), 0); };
    raf = requestAnimationFrame(step);
  };
  stopFx = () => cancelAnimationFrame(raf);

  $('#share').onclick = async (e) => {
    try {
      if (navigator.share) return await navigator.share({ title: r.title, text: 'Маршрут в Тропе: ' + r.title, url: location.href });
      await navigator.clipboard.writeText(location.href);
      e.target.textContent = 'Ссылка скопирована';
    } catch (ex) {
      if (ex.name !== 'AbortError') e.target.textContent = 'Скопируйте ссылку из адресной строки';
    }
  };
  if ($('#gpx')) $('#gpx').onclick = () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Тропа" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(r.title)}</name><trkseg>\n` +
      pts.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}${p[3] != null ? `<time>${new Date(p[3]).toISOString()}</time>` : ''}</trkpt>`).join('\n') +
      '\n</trkseg></trk></gpx>';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
    a.download = `tropa-${r.id}.gpx`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  if (mine) $('#del').onclick = async (e) => {
    if (!armed(e.target)) return;
    await api('/routes/' + id, null, 'DELETE');
    location.hash = '#me-routes';
  };
  if (me) {
    let pending = null;
    map.on('click', (e) => {
      pending?.remove();
      pending = L.marker(e.latlng, { icon: pin(), opacity: 0.7 }).addTo(map);
      $('#note-form').hidden = false;
      $('#note-text').focus();
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
  app.innerHTML = `<div class="wrap narrow"><div class="eyebrow">Вернулись с тропы?</div><h1>Новый маршрут</h1>
    <p class="err" role="alert" style="margin:14px 0">${esc(message)}</p>
    ${recording || rec.pts.length ? `
    <div class="panel rec">
      <h2>${recording ? '<span class="dot"></span>Идёт запись трека' : 'Есть несохранённая запись'}</h2>
      <p id="rec-stat" style="font-weight:700;font-variant-numeric:tabular-nums"></p>
      <div class="actions" style="justify-content:center">
        ${recording ? '' : '<button id="rec-go">Продолжить запись</button>'}
        <button class="accent" id="rec-done">Завершить и сохранить</button>
        <button class="ghost" id="rec-drop">Удалить запись</button>
      </div>
      <p class="muted">Держите экран включённым: браузер не записывает GPS в фоне.</p>
    </div>` : `
    <div class="panel">
      <h2>Синхронизировать с трекером</h2>
      <p class="muted">Закончили поход с Apple Watch, Garmin, Strava или Google Картами? Загрузите файл трека. Тропа построит маршрут и посчитает дистанцию, время и набор высоты.</p>
      <form onsubmit="return false">
        <label for="src">Откуда трек<select id="src">${['apple', 'google', 'strava', 'garmin', 'other'].map((s) => `<option value="${s}">${SRC[s]}</option>`).join('')}</select></label>
        <label for="file">Файл GPX или KML<input type="file" id="file" accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml"></label>
      </form>
      <details style="margin-top:14px"><summary>Где взять файл?</summary><ul>
        <li><b>Apple Watch:</b> приложение «Здоровье» → профиль → «Экспортировать медданные». В архиве папка <i>workout-routes</i> с файлами GPX.</li>
        <li><b>Google Карты:</b> «Мои карты» → меню карты → «Экспортировать в KML/KMZ» (выберите KML).</li>
        <li><b>Strava:</b> откройте тренировку на сайте → «…» → «Экспорт GPX».</li>
        <li><b>Garmin Connect:</b> тренировка → шестерёнка → «Экспорт в GPX».</li>
      </ul></details>
    </div>
    <div class="panel">
      <h2>Записать прямо сейчас</h2>
      <p class="muted">Включите трекер в начале пути. Тропа попросит доступ к геопозиции и будет записывать маршрут, пока вы идёте.</p>
      <button class="accent" id="rec-go">Начать запись</button>
    </div>`}</div>`;
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
    $('#rec-drop').onclick = (e) => { if (armed(e.target)) { recStop(); recClear(); add(); } };
  }
  if ($('#file')) $('#file').onchange = async (e) => {
    try {
      draft = { points: parseTrack(await e.target.files[0].text()), source: $('#src').value };
      add();
    } catch (ex) { add(ex.message); }
  };
}

function saveForm() {
  app.innerHTML = `<div class="wrap narrow"><div class="eyebrow">${SRC[draft.source]} · ${km(trackLen(draft.points))} · точек: ${draft.points.length}</div>
    <h1>Сохранить маршрут</h1>
    <div class="map small" id="map" style="margin-top:20px"></div>
    <form id="f" class="panel">
      <label for="f-title">Название<input id="f-title" type="text" name="title" required minlength="2" maxlength="100" placeholder="Например: Пик Черского из Слюдянки"></label>
      <label for="f-region">Регион или место<input id="f-region" type="text" name="region" maxlength="80" placeholder="Байкал, Иркутская область"></label>
      <label for="f-diff">Сложность<select id="f-diff" name="difficulty">${Object.entries(DIFF).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label for="f-descr">Описание и советы<textarea id="f-descr" name="descr" maxlength="3000" placeholder="Где вода, где стоянки, что взять с собой"></textarea></label>
      <label class="row" for="f-public"><input id="f-public" type="checkbox" name="public" checked> Показывать всем и опубликовать на моей стене</label>
      <p class="err" role="alert"></p>
      <div class="actions"><button type="submit">Сохранить</button><button type="button" class="ghost" id="cancel">Отмена</button></div>
    </form></div>`;
  mkMap($('#map'), draft.points);
  $('#cancel').onclick = () => { draft = null; add(); };
  onSubmit($('#f'), async (d) => {
    const { id } = await api('/routes', { ...d, public: d.public === 'on', points: draft.points, source: draft.source });
    if (draft.recorded) recClear(); // запись стираем только после успешного сохранения
    draft = null;
    location.hash = '#route-' + id;
  });
}

async function profile(id, tab = 'wall') {
  const u = await api('/users/' + id);
  const self = me?.id === u.id;
  const total = u.routes.reduce((s, r) => s + r.distance_m, 0), up = u.routes.reduce((s, r) => s + r.ascent_m, 0);
  app.innerHTML = `
    <section class="scenic phero">${TropaScene(100 + u.id, { h: 520, layers: 4 })}
      <div class="wrap">
        <div class="eyebrow" style="color:#ffcfb3">В Тропе с ${date(u.created)}</div>
        <h1>${esc(u.name)}</h1>
        <p class="text" style="max-width:36em;margin-top:12px">${esc(u.bio) || (self ? 'Расскажите о себе: какие походы любите.' : '')}</p>
        <dl class="totals">
          <div><dd data-cu="${u.routes.length}" data-f="n">${u.routes.length}</dd><dt>маршрутов</dt></div>
          <div><dd data-cu="${total}" data-f="km">${km(total)}</dd><dt>пройдено</dt></div>
          <div><dd data-cu="${up}" data-f="m">${Math.round(up)} м</dd><dt>набрано</dt></div>
        </dl>
      </div>
    </section>
    <div class="wrap narrow">
      ${self ? `<div class="actions"><button class="ghost" id="bio-btn">Изменить «о себе»</button><button class="ghost" id="out">Выйти</button></div>
        <form class="panel" id="bio-form" hidden><label for="bio-text">О себе (до 300 символов)<textarea id="bio-text" name="bio" maxlength="300">${esc(u.bio)}</textarea></label>
          <p class="err" role="alert"></p><button type="submit">Сохранить</button></form>` : ''}
      <div class="seg" role="tablist">
        <button role="tab" aria-selected="${tab !== 'routes'}" data-tab="wall">Стена</button>
        <button role="tab" aria-selected="${tab === 'routes'}" data-tab="routes">Маршруты</button>
      </div>
      ${tab === 'routes'
        ? (self ? '<div class="actions"><a class="btn accent" href="#add">+ Добавить маршрут</a></div>' : '') +
          `<div class="list">${u.routes.map(routeCard).join('') || '<p class="empty">Маршрутов пока нет.</p>'}</div>`
        : (self ? `<form class="panel" id="post-form" style="margin-top:18px">
            <label for="post-text">Что нового в походной жизни?<textarea id="post-text" name="text" maxlength="2000"></textarea></label>
            <label for="post-photo">Фото<input id="post-photo" type="file" name="photo" accept="image/*"></label>
            ${u.routes.some((r) => r.public) ? `<label for="post-route">Прикрепить маршрут<select id="post-route" name="route_id"><option value="">— без маршрута —</option>${u.routes.filter((r) => r.public).map((r) => `<option value="${r.id}">${esc(r.title)}</option>`).join('')}</select></label>` : ''}
            <p class="err" role="alert"></p><button type="submit">Опубликовать</button></form>` : '') +
          (u.posts.map(postCard).join('') || '<p class="empty">На стене пока пусто.</p>')}
    </div>`;
  parallax($('.phero'));
  countUp();
  app.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => (location.hash = `#u-${u.id}-${b.dataset.tab}`)));
  if (!self) return;
  $('#out').onclick = async () => { await api('/logout', {}); me = null; paintWho(); location.hash = '#'; router(); };
  $('#bio-btn').onclick = () => { $('#bio-form').hidden = !$('#bio-form').hidden; };
  onSubmit($('#bio-form'), async (d) => { await api('/me', { bio: d.bio }); router(); });
  if ($('#post-form')) onSubmit($('#post-form'), async (d) => {
    await api('/posts', { text: d.text, route_id: Number(d.route_id) || null, photo: await photoOf(d) });
    router();
  });
}

function auth(message = '', mode = 'login') {
  const reg = mode === 'register';
  app.innerHTML = `
    <section class="scenic phero">${TropaScene(3, { mood: 'dusk', h: 420, layers: 4 })}
      <div class="wrap"><h1>Тропа</h1><p style="max-width:32em;margin-top:12px">Сохраняйте пройденные маршруты, делитесь ими и выбирайте новые по отзывам туристов.</p></div></section>
    <div class="wrap narrow" style="max-width:520px">
      ${message ? `<p>${esc(message)}</p>` : ''}
      <div class="seg" role="tablist">
        <button role="tab" aria-selected="${!reg}" id="to-login">Вход</button>
        <button role="tab" aria-selected="${reg}" id="to-reg">Регистрация</button>
      </div>
      <form id="f" class="panel" style="margin-top:18px">
        ${reg ? '<label for="a-name">Имя<input id="a-name" type="text" name="name" required minlength="2" maxlength="40" autocomplete="name"></label>' : ''}
        <label for="a-email">Email<input id="a-email" type="email" name="email" required autocomplete="email"></label>
        <label for="a-pass">Пароль${reg ? ' (минимум 8 символов)' : ''}<input id="a-pass" type="password" name="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
        <p class="err" role="alert"></p><button type="submit">${reg ? 'Создать аккаунт' : 'Войти'}</button>
      </form>
    </div>`;
  $('#to-login').onclick = () => auth(message, 'login');
  $('#to-reg').onclick = () => auth(message, 'register');
  onSubmit($('#f'), async (d) => {
    me = await api(reg ? '/register' : '/login', d);
    paintWho();
    if (/^#(login|me)/.test(location.hash)) location.hash = '#me-routes'; else router();
  });
}

// ---------- роутер ----------
// Адреса вида #route-12 и #u-3-routes: только такие якоря переживают встраивание страницы в чужую рамку.
function paintWho() {
  $('#who').innerHTML = me ? `<a href="#me">${esc(me.name)}</a>` : '<a href="#login">Войти</a>';
}
async function router() {
  stopFx?.();
  stopFx = null;
  map?.remove();
  map = null;
  const [name, a, b] = location.hash.slice(1).split('-');
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
    app.innerHTML = `<div class="wrap"><p class="empty">${esc(ex.message)}<br><a href="#">На главную</a></p></div>`;
  }
  window.scrollTo(0, 0);
}
const go = () => (document.startViewTransition && !CALM ? document.startViewTransition(router) : router());

app.addEventListener('click', async (e) => {
  const post = e.target.dataset.delPost, note = e.target.dataset.delNote;
  if (!post && !note) return;
  if (!armed(e.target)) return;
  try { await api(post ? '/posts/' + post : '/notes/' + note, null, 'DELETE'); router(); } catch (ex) { e.target.textContent = ex.message; }
});
window.addEventListener('hashchange', go);
if (DEMO) $('.top').insertAdjacentHTML('afterend', '<p class="demo-note">Демо-версия: всё работает, но данные живут только в этой вкладке, а карта показывает условный рельеф.</p>');
api('/me').then((r) => { me = r.user; }).catch(() => {}).finally(() => { paintWho(); router(); });
