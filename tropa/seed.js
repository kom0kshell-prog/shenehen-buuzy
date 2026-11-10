// Демо-данные: node server.js --seed (ничего не делает, если в базе уже есть пользователи).
// Треки синтетические — проложены между реальными точками, но это не записи с GPS.
const { createRoute, hashPass, run, one } = require('./server');

function track(waypoints, hours, n = 240) {
  const pts = [];
  const t0 = Date.UTC(2026, 6, 12, 1, 0);
  for (let i = 0; i < n; i++) {
    const f = (i / (n - 1)) * (waypoints.length - 1);
    const k = Math.min(Math.floor(f), waypoints.length - 2), u = f - k;
    const [a, b] = [waypoints[k], waypoints[k + 1]];
    const wiggle = Math.sin(i * 0.45) * 0.0012 + Math.sin(i * 0.13) * 0.002;
    pts.push([
      a[0] + (b[0] - a[0]) * u + wiggle,
      a[1] + (b[1] - a[1]) * u + wiggle * 1.4,
      Math.round(a[2] + (b[2] - a[2]) * u + Math.sin(i * 0.3) * 12),
      t0 + (i / (n - 1)) * hours * 3600e3,
    ]);
  }
  return pts;
}

module.exports = function seed() {
  if (one('SELECT 1 FROM users LIMIT 1')) return;
  const user = (name, email, bio) =>
    Number(run('INSERT INTO users (name,email,pass,bio,created) VALUES (?,?,?,?,?)', name, email, hashPass('demo12345'), bio, Date.now()).lastInsertRowid);
  const ayuna = user('Аюна Доржиева', 'ayuna@demo.tropa', 'Хожу по Прибайкалью круглый год. Люблю маршруты с видом на воду.');
  const misha = user('Миша Соколов', 'misha@demo.tropa', 'Горный туризм, Хамар-Дабан и Саяны.');
  const lena = user('Лена Ким', 'lena@demo.tropa', 'Походы выходного дня с детьми.');

  const day = 86400e3, now = Date.now();
  const note = (route, u, lat, lng, text) => run('INSERT INTO notes (route_id,user_id,lat,lng,text,created) VALUES (?,?,?,?,?,?)', route, u, lat, lng, text, now);
  const review = (route, u, rating, text) => run('INSERT INTO reviews (route_id,user_id,rating,text,created) VALUES (?,?,?,?,?)', route, u, rating, text, now);

  const bbt = createRoute(ayuna, {
    title: 'Большая Байкальская тропа: Листвянка — Большие Коты', region: 'Байкал, Иркутская область', difficulty: 'medium', source: 'apple',
    descr: 'Классика БТ: перевал в начале, дальше тропа идёт над самой водой. Обратно — на катере из Больших Котов.',
    points: track([[51.853, 104.869, 460], [51.872, 104.905, 780], [51.880, 104.960, 470], [51.893, 105.020, 520], [51.905, 105.075, 458]], 6.5),
    created: now - 9 * day,
  });
  note(bbt, ayuna, 51.872, 104.905, 'Перевал. Дальше только вниз — можно выдохнуть. Связь ловит последний раз.');
  note(bbt, ayuna, 51.880, 104.960, 'Отличная стоянка на галечном пляже, есть кострище и ручей в 50 м.');
  note(bbt, misha, 51.893, 105.020, 'Скальный прижим: после дождя скользко, детей держите за руку.');
  review(bbt, misha, 5, 'Вода есть только в двух ручьях до середины пути — берите минимум 1,5 л. Расписание катера уточняйте заранее, последний уходит рано.');
  review(bbt, lena, 4, 'Шли с ребёнком 9 лет — справился, но подъём в начале тяжёлый. Треккинговые палки очень помогли.');

  const cher = createRoute(misha, {
    title: 'Пик Черского из Слюдянки', region: 'Хамар-Дабан, Иркутская область', difficulty: 'hard', source: 'garmin',
    descr: 'Два дня с ночёвкой у метеостанции. Набор больше 1500 м, на вершине вид на Байкал и озеро Сердце.',
    points: track([[51.640, 103.700, 520], [51.585, 103.672, 900], [51.540, 103.640, 1400], [51.515, 103.626, 2090]], 9, 300),
    created: now - 5 * day,
  });
  note(cher, misha, 51.585, 103.672, 'Казачья поляна — удобное место для обеда, вода из реки.');
  note(cher, misha, 51.540, 103.640, 'Метеостанция: платная стоянка, есть баня. Клещей в июне много — проверяйтесь.');
  review(cher, ayuna, 5, 'Выходите на вершину до 8 утра — к обеду затягивает облаками. Переправы после дождей по колено.');

  const tal = createRoute(lena, {
    title: 'Тальцы — смотровая на Ангару', region: 'Иркутск', difficulty: 'easy', source: 'google',
    descr: 'Лёгкая прогулка на полдня, подходит для детей и колясок-внедорожников.',
    points: track([[52.000, 104.660, 460], [52.008, 104.672, 520], [52.015, 104.690, 540]], 1.8, 120),
    created: now - 2 * day,
  });
  note(tal, lena, 52.008, 104.672, 'Беседка и столик — идеальный привал для перекуса.');
  review(tal, ayuna, 4, 'Хорошо на закате. Парковка у музея платная, чуть дальше есть бесплатный карман.');

  run('INSERT INTO posts (user_id,text,created) VALUES (?,?,?)', ayuna, 'Собираю группу на Шумак в августе. Кто ходил через перевал — напишите подсказки в отзывах!', now - day);
  console.log('Демо-данные добавлены. Вход: ayuna@demo.tropa / demo12345');
};
