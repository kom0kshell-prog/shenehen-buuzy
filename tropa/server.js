// Тропа — соцсеть туристических маршрутов. Без зависимостей: node:http + node:sqlite (Node 22.13+).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'tropa.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  pass TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, descr TEXT NOT NULL, region TEXT NOT NULL, difficulty TEXT NOT NULL, source TEXT NOT NULL,
  points TEXT NOT NULL, preview TEXT NOT NULL, search TEXT NOT NULL,
  distance_m REAL NOT NULL, duration_s INTEGER, ascent_m REAL NOT NULL,
  public INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY, route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat REAL NOT NULL, lng REAL NOT NULL, text TEXT NOT NULL, photo TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(route_id, user_id));
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL, photo TEXT, route_id INTEGER REFERENCES routes(id) ON DELETE CASCADE, created INTEGER NOT NULL);
`);

const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const now = () => Date.now();

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- validation ----------
function str(v, name, max, min = 0) {
  if (typeof v !== 'string') v = '';
  v = v.trim();
  if (v.length < min) throw bad(`Поле «${name}» обязательно`);
  if (v.length > max) throw bad(`Поле «${name}» длиннее ${max} символов`);
  return v;
}
const DIFFICULTY = ['easy', 'medium', 'hard'];
const SOURCES = ['app', 'apple', 'google', 'strava', 'garmin', 'other'];
const oneOf = (v, list) => (list.includes(v) ? v : list[0]);

function savePhoto(dataUrl) {
  if (!dataUrl) return null;
  const m = typeof dataUrl === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw bad('Фото должно быть в формате JPEG');
  const buf = Buffer.from(m[1], 'base64');
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw bad('Файл не похож на JPEG');
  const name = crypto.randomUUID() + '.jpg';
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return '/uploads/' + name;
}
function dropPhoto(url) {
  if (url) fs.rm(path.join(UPLOADS, path.basename(url)), { force: true }, () => {});
}

// ---------- geo ----------
function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// points: [[lat, lng, ele|null, tMs|null], ...]
function trackStats(pts) {
  let distance = 0, ascent = 0, ref = null;
  for (let i = 0; i < pts.length; i++) {
    if (i) distance += haversine(pts[i - 1], pts[i]);
    const ele = pts[i][2];
    if (ele == null) continue;
    if (ref == null) ref = ele;
    // порог 3 м гасит шум GPS-высоты
    else if (ele - ref > 3) { ascent += ele - ref; ref = ele; }
    else if (ref - ele > 3) ref = ele;
  }
  const t0 = pts[0][3], t1 = pts[pts.length - 1][3];
  const duration = t0 != null && t1 != null && t1 > t0 ? Math.round((t1 - t0) / 1000) : null;
  return { distance, ascent, duration };
}
function cleanPoints(raw) {
  if (!Array.isArray(raw) || raw.length < 2) throw bad('В треке должно быть минимум 2 точки');
  if (raw.length > 5000) throw bad('Слишком длинный трек (максимум 5000 точек)');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return raw.map((p) => {
    if (!Array.isArray(p)) throw bad('Неверный формат трека');
    const lat = num(p[0]), lng = num(p[1]);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad('Неверные координаты в треке');
    return [lat, lng, num(p[2]), num(p[3])];
  });
}

// ---------- domain ----------
function createRoute(userId, b) {
  const points = cleanPoints(b.points);
  const title = str(b.title, 'Название', 100, 2);
  const descr = str(b.descr, 'Описание', 3000);
  const region = str(b.region, 'Регион', 80);
  const st = trackStats(points);
  const step = Math.ceil(points.length / 60);
  const preview = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => [p[0], p[1]]);
  const isPublic = b.public === false ? 0 : 1;
  const created = b.created || now();
  const id = run(
    `INSERT INTO routes (user_id,title,descr,region,difficulty,source,points,preview,search,distance_m,duration_s,ascent_m,public,created)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    userId, title, descr, region, oneOf(b.difficulty, DIFFICULTY), oneOf(b.source, SOURCES),
    JSON.stringify(points), JSON.stringify(preview), `${title} ${region} ${descr}`.toLowerCase(),
    st.distance, st.duration, st.ascent, isPublic, created
  ).lastInsertRowid;
  // публичный маршрут сразу попадает на стену автора
  if (isPublic) run('INSERT INTO posts (user_id,text,photo,route_id,created) VALUES (?,?,NULL,?,?)', userId, '', id, created);
  return Number(id);
}

const ROUTE_CARD = `r.id, r.user_id, r.title, r.region, r.difficulty, r.source, r.preview, r.distance_m, r.duration_s,
  r.ascent_m, r.public, r.created, u.name AS author,
  (SELECT AVG(rating) FROM reviews WHERE route_id = r.id) AS rating,
  (SELECT COUNT(*) FROM reviews WHERE route_id = r.id) AS reviews,
  (SELECT COUNT(*) FROM notes WHERE route_id = r.id) AS notes,
  (SELECT photo FROM notes WHERE route_id = r.id AND photo IS NOT NULL ORDER BY id LIMIT 1) AS cover`;
const card = (r) => r && { ...r, preview: JSON.parse(r.preview) };

function visibleRoute(id, user) {
  const r = one(`SELECT ${ROUTE_CARD}, r.descr, r.points FROM routes r JOIN users u ON u.id = r.user_id WHERE r.id = ?`, id);
  if (!r || (!r.public && r.user_id !== user?.id)) throw new HttpError(404, 'Маршрут не найден');
  return r;
}
function postsWhere(where, ...args) {
  const posts = all(
    `SELECT p.id, p.user_id, p.text, p.photo, p.route_id, p.created, u.name AS author
     FROM posts p JOIN users u ON u.id = p.user_id ${where} ORDER BY p.created DESC, p.id DESC LIMIT 60`, ...args);
  for (const p of posts) {
    if (p.route_id) p.route = card(one(`SELECT ${ROUTE_CARD} FROM routes r JOIN users u ON u.id = r.user_id WHERE r.id = ?`, p.route_id));
  }
  return posts;
}

// ---------- auth ----------
const hashPass = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
function checkPass(pw, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(pw, salt, 32));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token,user_id,created) VALUES (?,?,?)', sha(token), userId, now());
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}
function currentUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? one('SELECT u.id, u.name, u.email, u.bio FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', sha(m[1])) : null;
}
function need(user) {
  if (!user) throw new HttpError(401, 'Войдите в аккаунт');
  return user;
}

// ---------- API ----------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^/api' + pattern + '$'), fn });

on('POST', '/register', ({ req, res, body }) => {
  const name = str(body.name, 'Имя', 40, 2);
  const email = str(body.email, 'Email', 120, 3).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Неверный email');
  if (typeof body.password !== 'string' || body.password.length < 8) throw bad('Пароль — минимум 8 символов');
  if (one('SELECT 1 FROM users WHERE email = ?', email)) throw bad('Этот email уже зарегистрирован');
  const id = run('INSERT INTO users (name,email,pass,created) VALUES (?,?,?,?)', name, email, hashPass(body.password), now()).lastInsertRowid;
  startSession(req, res, id);
  return { id: Number(id), name, email, bio: '' };
});
on('POST', '/login', ({ req, res, body }) => {
  const u = one('SELECT * FROM users WHERE email = ?', String(body.email || '').trim().toLowerCase());
  if (!u || typeof body.password !== 'string' || !checkPass(body.password, u.pass)) throw new HttpError(401, 'Неверный email или пароль');
  startSession(req, res, u.id);
  return { id: u.id, name: u.name, email: u.email, bio: u.bio };
});
on('POST', '/logout', ({ req, res }) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m) run('DELETE FROM sessions WHERE token = ?', sha(m[1]));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return {};
});
on('GET', '/me', ({ user }) => ({ user }));
on('POST', '/me', ({ user, body }) => {
  need(user);
  run('UPDATE users SET bio = ? WHERE id = ?', str(body.bio, 'О себе', 300), user.id);
  return {};
});

on('GET', '/routes', ({ url }) => {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
  return all(
    `SELECT ${ROUTE_CARD} FROM routes r JOIN users u ON u.id = r.user_id
     WHERE r.public = 1 AND (? = '' OR instr(r.search, ?) > 0) ORDER BY r.created DESC LIMIT 100`, q, q).map(card);
});
on('POST', '/routes', ({ user, body }) => ({ id: createRoute(need(user).id, body) }));
on('GET', '/routes/(\\d+)', ({ user, params }) => {
  const r = visibleRoute(params[0], user);
  return {
    ...card(r), points: JSON.parse(r.points),
    noteList: all('SELECT n.id, n.user_id, n.lat, n.lng, n.text, n.photo, n.created, u.name AS author FROM notes n JOIN users u ON u.id = n.user_id WHERE n.route_id = ? ORDER BY n.id', r.id),
    reviewList: all('SELECT v.id, v.user_id, v.rating, v.text, v.created, u.name AS author FROM reviews v JOIN users u ON u.id = v.user_id WHERE v.route_id = ? ORDER BY v.created DESC', r.id),
  };
});
on('DELETE', '/routes/(\\d+)', ({ user, params }) => {
  const r = one('SELECT id, user_id FROM routes WHERE id = ?', params[0]);
  if (!r || r.user_id !== need(user).id) throw new HttpError(403, 'Это не ваш маршрут');
  const photos = all('SELECT photo FROM notes WHERE route_id = ? AND photo IS NOT NULL', r.id);
  run('DELETE FROM routes WHERE id = ?', r.id);
  photos.forEach((p) => dropPhoto(p.photo));
  return {};
});
on('POST', '/routes/(\\d+)/notes', ({ user, params, body }) => {
  need(user);
  const r = visibleRoute(params[0], user);
  const text = str(body.text, 'Пометка', 1000, body.photo ? 0 : 1);
  const [[lat, lng]] = cleanPoints([[body.lat, body.lng], [body.lat, body.lng]]);
  const photo = savePhoto(body.photo);
  return { id: Number(run('INSERT INTO notes (route_id,user_id,lat,lng,text,photo,created) VALUES (?,?,?,?,?,?,?)', r.id, user.id, lat, lng, text, photo, now()).lastInsertRowid) };
});
on('DELETE', '/notes/(\\d+)', ({ user, params }) => {
  need(user);
  const n = one('SELECT n.id, n.user_id, n.photo, r.user_id AS owner FROM notes n JOIN routes r ON r.id = n.route_id WHERE n.id = ?', params[0]);
  if (!n || (n.user_id !== user.id && n.owner !== user.id)) throw new HttpError(403, 'Нельзя удалить чужую пометку');
  run('DELETE FROM notes WHERE id = ?', n.id);
  dropPhoto(n.photo);
  return {};
});
on('POST', '/routes/(\\d+)/reviews', ({ user, params, body }) => {
  need(user);
  const r = visibleRoute(params[0], user);
  if (r.user_id === user.id) throw bad('Свой маршрут оценивать нельзя — добавьте пометку на карте');
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('Оценка — от 1 до 5');
  const text = str(body.text, 'Отзыв', 2000, 3);
  run(`INSERT INTO reviews (route_id,user_id,rating,text,created) VALUES (?,?,?,?,?)
       ON CONFLICT(route_id,user_id) DO UPDATE SET rating = excluded.rating, text = excluded.text, created = excluded.created`,
    r.id, user.id, rating, text, now());
  return {};
});

on('GET', '/feed', () => postsWhere('WHERE p.route_id IS NULL OR EXISTS (SELECT 1 FROM routes WHERE id = p.route_id AND public = 1)'));
on('POST', '/posts', ({ user, body }) => {
  need(user);
  const text = str(body.text, 'Текст', 2000, body.photo || body.route_id ? 0 : 1);
  const routeId = body.route_id ? visibleRoute(body.route_id, user).id : null;
  const photo = savePhoto(body.photo);
  return { id: Number(run('INSERT INTO posts (user_id,text,photo,route_id,created) VALUES (?,?,?,?,?)', user.id, text, photo, routeId, now()).lastInsertRowid) };
});
on('DELETE', '/posts/(\\d+)', ({ user, params }) => {
  const p = one('SELECT id, user_id, photo FROM posts WHERE id = ?', params[0]);
  if (!p || p.user_id !== need(user).id) throw new HttpError(403, 'Это не ваша запись');
  run('DELETE FROM posts WHERE id = ?', p.id);
  dropPhoto(p.photo);
  return {};
});
on('GET', '/users/(\\d+)', ({ user, params }) => {
  const u = one('SELECT id, name, bio, created FROM users WHERE id = ?', params[0]);
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  const self = user?.id === u.id ? 1 : 0;
  return {
    ...u,
    routes: all(`SELECT ${ROUTE_CARD} FROM routes r JOIN users u ON u.id = r.user_id WHERE r.user_id = ? AND (r.public = 1 OR ?) ORDER BY r.created DESC`, u.id, self).map(card),
    posts: postsWhere('WHERE p.user_id = ? AND (p.route_id IS NULL OR ? OR EXISTS (SELECT 1 FROM routes WHERE id = p.route_id AND public = 1))', u.id, self),
  };
});

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 6e6) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(bad('Неверный JSON')); }
    });
    req.on('error', reject);
  });
}
function serveFile(res, root, rel) {
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && r.re.exec(url.pathname);
        if (!m) continue;
        let body = {};
        if (req.method !== 'GET') {
          // JSON-only + SameSite=Lax: чужая форма не может отправить такой запрос (CSRF)
          if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Нужен application/json');
          body = await readBody(req);
          if (!body || typeof body !== 'object') throw bad('Неверный JSON');
        }
        const out = r.fn({ req, res, url, body, params: m.slice(1), user: currentUser(req) });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(out));
      }
      throw new HttpError(404, 'Не найдено');
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается');
    const rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/uploads/') && serveFile(res, UPLOADS, rel.slice('/uploads/'.length))) return;
    if (serveFile(res, PUBLIC, rel === '/' ? 'index.html' : rel.slice(1))) return;
    throw new HttpError(404, 'Не найдено');
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.status ? e.message : 'Ошибка сервера' }));
  }
});

module.exports = { server, db, createRoute, trackStats, hashPass, run, one };

if (require.main === module) {
  if (process.argv.includes('--seed')) require('./seed')();
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Тропа запущена: http://localhost:${port}`));
}
