// Собирает демо без сервера в demo/dist: node demo/build.js
// dist/index.html — открыть локально; dist/page.html — фрагмент для публикации как страницы-артефакта.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tropa-demo-'));
const { db } = require('../server');
require('../seed')();
const all = (sql) => db.prepare(sql).all();
const data = {
  users: all('SELECT id, name, email, bio, created FROM users'),
  routes: all('SELECT id, user_id, title, descr, region, difficulty, source, points, preview, distance_m, duration_s, ascent_m, public, created FROM routes').map((r) => ({
    ...r, points: JSON.parse(r.points), preview: JSON.parse(r.preview),
    noteList: db.prepare('SELECT id, user_id, lat, lng, text, photo, created FROM notes WHERE route_id = ?').all(r.id),
    reviewList: db.prepare('SELECT id, user_id, rating, text, created FROM reviews WHERE route_id = ?').all(r.id),
  })),
  posts: all('SELECT id, user_id, text, photo, route_id, created FROM posts'),
};

const pub = path.join(__dirname, '..', 'public'), dist = path.join(__dirname, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(pub, dist, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'demo-api.js'), path.join(dist, 'demo-api.js'));
fs.writeFileSync(path.join(dist, 'data.js'), 'window.TROPA_DEMO = 1; window.DEMO_DATA = ' + JSON.stringify(data) + ';');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace('<!--demo-->', '<script src="data.js"></script>\n<script src="demo-api.js"></script>');
fs.writeFileSync(path.join(dist, 'index.html'), html);
// фрагмент без <html>/<head>/<body>: каркас добавляет площадка
fs.writeFileSync(path.join(dist, 'page.html'), `<title>Тропа</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Manrope:wght@400..800&display=swap">
<link rel="stylesheet" href="vendor/leaflet.css">
<link rel="stylesheet" href="style.css">
${html.split('<!--app-->')[1].split('<!--/app-->')[0]}`);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log('Демо собрано: demo/dist');
