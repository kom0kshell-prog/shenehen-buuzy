const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tropa-'));
const { server, trackStats } = require('./server');

let base;
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
}
const points = [[51.85, 104.86, 460, 1e12], [51.86, 104.88, 500, 1e12 + 3600e3], [51.87, 104.9, 480, 1e12 + 7200e3]];
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

test.before(() => new Promise((ok) => server.listen(0, () => { base = 'http://localhost:' + server.address().port; ok(); })));
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

test('trackStats: дистанция, время, набор высоты', () => {
  const s = trackStats(points);
  assert.ok(s.distance > 3000 && s.distance < 4000, String(s.distance));
  assert.equal(s.duration, 7200);
  assert.equal(s.ascent, 40);
});

test('путь туриста: трек → пометка с фото → отзыв другого → поиск → стена', async () => {
  const anna = client(), boris = client(), guest = client();
  assert.equal((await anna('POST', '/api/register', { name: 'Анна', email: 'a@t.ru', password: 'password1' })).status, 200);
  assert.equal((await boris('POST', '/api/register', { name: 'Борис', email: 'b@t.ru', password: 'password2' })).status, 200);
  assert.equal((await boris('POST', '/api/register', { name: 'Борис', email: 'b@t.ru', password: 'password2' })).status, 400);
  assert.equal((await guest('POST', '/api/login', { email: 'a@t.ru', password: 'wrong' })).status, 401);
  assert.equal((await guest('POST', '/api/routes', { title: 'x', points })).status, 401);

  const { body: { id } } = await anna('POST', '/api/routes', { title: 'Тропа на БАЙКАЛ', region: 'Иркутск', descr: '', difficulty: 'medium', source: 'apple', points });
  const priv = (await anna('POST', '/api/routes', { title: 'Секретное место', points, public: false })).body.id;
  assert.equal((await anna('POST', '/api/routes', { title: 'Плохой', points: [[999, 0], [0, 0]] })).status, 400);

  assert.equal((await boris('POST', `/api/routes/${id}/notes`, { lat: 51.86, lng: 104.88, text: 'Родник', photo: JPEG })).status, 200);
  assert.equal((await boris('POST', `/api/routes/${id}/notes`, { lat: 51.86, lng: 104.88, text: 'x', photo: 'data:text/html;base64,PGI+' })).status, 400);
  assert.equal((await anna('POST', `/api/routes/${id}/reviews`, { rating: 5, text: 'Сама себе' })).status, 400);
  assert.equal((await boris('POST', `/api/routes/${id}/reviews`, { rating: 3, text: 'Нормально' })).status, 200);
  assert.equal((await boris('POST', `/api/routes/${id}/reviews`, { rating: 4, text: 'Берите воду' })).status, 200); // обновляет, не дублирует

  const full = (await guest('GET', `/api/routes/${id}`)).body;
  assert.equal(full.reviews, 1);
  assert.equal(full.rating, 4);
  assert.equal(full.noteList.length, 1);
  assert.equal((await fetch(base + full.noteList[0].photo)).status, 200);

  // поиск по кириллице без учёта регистра; приватный маршрут не виден чужим
  assert.deepEqual((await guest('GET', '/api/routes?q=' + encodeURIComponent('байкал'))).body.map((r) => r.id), [id]);
  assert.equal((await guest('GET', '/api/routes')).body.length, 1);
  assert.equal((await boris('GET', `/api/routes/${priv}`)).status, 404);
  assert.equal((await anna('GET', `/api/routes/${priv}`)).status, 200);

  const annaId = (await anna('GET', '/api/me')).body.user.id;
  assert.equal((await guest('GET', `/api/users/${annaId}`)).body.routes.length, 1);
  assert.equal((await anna('GET', `/api/users/${annaId}`)).body.routes.length, 2);
  assert.equal((await guest('GET', '/api/feed')).body[0].route.id, id);

  assert.equal((await boris('DELETE', `/api/routes/${id}`)).status, 403);
  assert.equal((await anna('DELETE', `/api/routes/${id}`)).status, 200);
  assert.equal((await guest('GET', '/api/feed')).body.length, 0);
  assert.equal((await fetch(base + '/uploads/..%2Ftropa.db')).status, 404);
});
