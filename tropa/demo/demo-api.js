// Демо без сервера: тот же интерфейс работает поверх данных в памяти вкладки.
// Повторяет ответы server.js; данные берутся из data.js (собирает demo/build.js из seed.js).
(function () {
  const D = window.DEMO_DATA;
  let me = { id: 100, name: 'Гость', email: 'guest@demo.tropa', bio: 'Смотрю демо Тропы.', created: Date.now() };
  D.users.push(me);
  let nextId = 1000;
  const fail = (msg) => { throw new Error(msg); };
  const user = (id) => D.users.find((u) => u.id === id);
  const hav = (a, b) => {
    const R = 6371000, rad = Math.PI / 180;
    const h = Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const card = (r) => {
    const { points, noteList, reviewList, ...c } = r;
    return { ...c, author: user(r.user_id).name, reviews: reviewList.length, notes: noteList.length,
      rating: reviewList.length ? reviewList.reduce((s, v) => s + v.rating, 0) / reviewList.length : null,
      cover: noteList.find((n) => n.photo)?.photo || null };
  };
  const route = (id) => D.routes.find((r) => r.id === Number(id) && (r.public || r.user_id === me?.id)) || fail('Маршрут не найден');
  const posts = (list) => list.slice().sort((a, b) => b.created - a.created).map((p) => {
    const r = p.route_id && D.routes.find((x) => x.id === p.route_id);
    return { ...p, author: user(p.user_id).name, route: r ? card(r) : undefined };
  }).filter((p) => !p.route_id || (p.route && (p.route.public || p.user_id === me?.id)));
  const need = () => me || fail('Войдите в аккаунт');

  window.demoApi = async (path, body, method) => {
    const [, res, id, sub] = path.split('?')[0].split('/');
    const q = decodeURIComponent((path.split('q=')[1] || '')).trim().toLowerCase();
    const key = `${method} /${res}${id ? '/:id' : ''}${sub ? '/' + sub : ''}`;
    switch (key) {
      case 'GET /me': return { user: me };
      case 'POST /me': need().bio = body.bio; return {};
      case 'POST /logout': me = null; return {};
      case 'POST /login': return (me = D.users.find((u) => u.email === String(body.email).toLowerCase()) || fail('В демо входите как ayuna@demo.tropa или зарегистрируйтесь'));
      case 'POST /register': me = { id: nextId++, name: body.name, email: String(body.email).toLowerCase(), bio: '', created: Date.now() }; D.users.push(me); return me;
      case 'GET /routes': return D.routes.filter((r) => r.public && (!q || `${r.title} ${r.region} ${r.descr}`.toLowerCase().includes(q))).sort((a, b) => b.created - a.created).map(card);
      case 'POST /routes': {
        const pts = body.points;
        let distance = 0, ascent = 0, ref = null;
        pts.forEach((p, i) => {
          if (i) distance += hav(pts[i - 1], p);
          if (p[2] == null) return;
          if (ref == null) ref = p[2]; else if (p[2] - ref > 3) { ascent += p[2] - ref; ref = p[2]; } else if (ref - p[2] > 3) ref = p[2];
        });
        const t0 = pts[0][3], t1 = pts[pts.length - 1][3], step = Math.ceil(pts.length / 60);
        const r = { id: nextId++, user_id: need().id, title: body.title, descr: body.descr || '', region: body.region || '', difficulty: body.difficulty || 'easy', source: body.source,
          points: pts, preview: pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => [p[0], p[1]]),
          distance_m: distance, ascent_m: ascent, duration_s: t0 && t1 > t0 ? Math.round((t1 - t0) / 1000) : null, public: body.public ? 1 : 0, created: Date.now(), noteList: [], reviewList: [] };
        D.routes.push(r);
        if (r.public) D.posts.push({ id: nextId++, user_id: me.id, text: '', photo: null, route_id: r.id, created: r.created });
        return { id: r.id };
      }
      case 'GET /routes/:id': { const r = route(id); return { ...card(r), points: r.points, noteList: r.noteList.map((n) => ({ ...n, author: user(n.user_id).name })), reviewList: r.reviewList.map((v) => ({ ...v, author: user(v.user_id).name })) }; }
      case 'DELETE /routes/:id': D.routes = D.routes.filter((r) => r.id !== Number(id)); D.posts = D.posts.filter((p) => p.route_id !== Number(id)); return {};
      case 'POST /routes/:id/notes':
        if (!body.text && !body.photo) fail('Поле «Пометка» обязательно');
        route(id).noteList.push({ id: nextId++, user_id: need().id, lat: body.lat, lng: body.lng, text: body.text || '', photo: body.photo || null, created: Date.now() }); return {};
      case 'DELETE /notes/:id': D.routes.forEach((r) => (r.noteList = r.noteList.filter((n) => n.id !== Number(id)))); return {};
      case 'POST /routes/:id/reviews': {
        const r = route(id);
        r.reviewList = r.reviewList.filter((v) => v.user_id !== need().id);
        r.reviewList.unshift({ id: nextId++, user_id: me.id, rating: body.rating, text: body.text, created: Date.now() }); return {};
      }
      case 'GET /feed': return posts(D.posts);
      case 'POST /posts':
        if (!body.text && !body.photo && !body.route_id) fail('Поле «Текст» обязательно');
        D.posts.push({ id: nextId++, user_id: need().id, text: body.text || '', photo: body.photo || null, route_id: body.route_id || null, created: Date.now() }); return {};
      case 'DELETE /posts/:id': D.posts = D.posts.filter((p) => p.id !== Number(id)); return {};
      case 'GET /users/:id': {
        const u = user(Number(id)) || fail('Пользователь не найден'), self = me?.id === u.id;
        return { ...u, routes: D.routes.filter((r) => r.user_id === u.id && (r.public || self)).sort((a, b) => b.created - a.created).map(card), posts: posts(D.posts.filter((p) => p.user_id === u.id)) };
      }
    }
    fail('Не найдено');
  };

  // Условный рельеф вместо картографических тайлов: в демо нет доступа к внешним картам.
  // Высоты — шум, а не реальная местность; с треками они не связаны.
  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, a = u * u * (3 - 2 * u), b = v * v * (3 - 2 * v);
    return hash(xi, yi) * (1 - a) * (1 - b) + hash(xi + 1, yi) * a * (1 - b) + hash(xi, yi + 1) * (1 - a) * b + hash(xi + 1, yi + 1) * a * b;
  };
  const height = (x, y) => noise(x, y) * 0.55 + noise(x * 2.1, y * 2.1) * 0.27 + noise(x * 4.7, y * 4.7) * 0.12 + noise(x * 9.9, y * 9.9) * 0.06;
  const RAMP = [[0.3, [169, 196, 178]], [0.45, [203, 216, 190]], [0.6, [226, 222, 196]], [0.75, [214, 205, 188]], [1, [244, 244, 240]]];
  window.demoRelief = () => new (L.GridLayer.extend({
    createTile(c) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const g = cv.getContext('2d'), img = g.createImageData(256, 256), k = 700 / Math.pow(2, c.z), B = 2;
      for (let py = 0; py < 256; py += B) for (let px = 0; px < 256; px += B) {
        const x = (c.x + px / 256) * k, y = (c.y + py / 256) * k, h = height(x, y);
        const shade = (height(x + k / 300, y + k / 300) - h) * 26; // свет с северо-запада
        const i = RAMP.findIndex((s) => h <= s[0]), lo = RAMP[Math.max(0, i - 1)], hi = RAMP[i], t = i ? (h - lo[0]) / (hi[0] - lo[0]) : 0;
        const line = (h * 28) % 1 < 0.07 ? -22 : 0;
        for (let dy = 0; dy < B; dy++) for (let dx = 0; dx < B; dx++) {
          const o = ((py + dy) * 256 + px + dx) * 4;
          for (let ch = 0; ch < 3; ch++) img.data[o + ch] = (i ? lo[1][ch] + (hi[1][ch] - lo[1][ch]) * t : hi[1][ch]) * (1 - shade) + line;
          img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      return cv;
    },
  }))({ attribution: 'Условный рельеф (демо)' });
})();
