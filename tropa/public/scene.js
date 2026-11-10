// Процедурный горный пейзаж в SVG: слои хребтов с воздушной перспективой, солнце, туман, ели.
// Один seed — всегда один и тот же пейзаж, поэтому у каждого маршрута своя «обложка».
// Используется на сайте (public/app.js) и в рекламном ролике (promo/promo.html).
(function (root) {
  function rng(seed) {
    let a = (Math.imul(seed | 0, 2654435761) >>> 0) || 1;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const mix = (a, b, t) => {
    const x = hex(a), y = hex(b);
    return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
  };
  const MOODS = {
    dawn: { sky: ['#182745', '#5d6494', '#dd9c8c', '#f6d7b4'], sun: '#ffe7c2', far: '#8d8cb0', near: '#13232b', haze: '#efc6b2' },
    day: { sky: ['#356f9c', '#86b4cf', '#cfe2ea', '#edf4f2'], sun: '#fffbe6', far: '#9db9c9', near: '#15352f', haze: '#e2edef' },
    dusk: { sky: ['#0b1430', '#35305f', '#a8526f', '#eb9a6c'], sun: '#ffc394', far: '#5a5384', near: '#0c1820', haze: '#c58686' },
  };
  const MOOD_NAMES = Object.keys(MOODS);

  function scene(seed, o = {}) {
    const W = 1200, H = o.h || 640, n = o.layers || 5;
    const r = rng(seed), m = MOODS[o.mood || MOOD_NAMES[seed % 3]], id = 'sc' + seed + '_' + (o.key || 0);
    const sunX = W * (0.22 + r() * 0.56), sunY = H * (0.3 + r() * 0.1);
    let defs = `<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1">${m.sky.map((c, i) => `<stop offset="${[0, 0.38, 0.68, 0.9][i]}" stop-color="${c}"/>`).join('')}</linearGradient>
      <radialGradient id="${id}g"><stop offset="0" stop-color="${m.sun}" stop-opacity=".95"/><stop offset=".18" stop-color="${m.sun}" stop-opacity=".45"/><stop offset="1" stop-color="${m.sun}" stop-opacity="0"/></radialGradient>
      <filter id="${id}b" x="-20%" y="-80%" width="140%" height="260%"><feGaussianBlur stdDeviation="22"/></filter>`;
    let body = `<rect x="-100" width="${W + 200}" height="${H}" fill="url(#${id}s)"/>
      <g class="sun"><circle cx="${sunX}" cy="${sunY}" r="${H * 0.62}" fill="url(#${id}g)"/><circle cx="${sunX}" cy="${sunY}" r="${H * 0.034}" fill="${m.sun}"/></g>`;
    let trail = '';
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), base = H * (0.5 + 0.42 * t), amp = H * (0.3 - 0.17 * t), sharp = 1 - t;
      const oct = [1.1, 2.7, 5.9, 12.7].map((f, k) => [f * (0.8 + r() * 0.5), r() * 6.283, 1 / (1 << k)]);
      const y = (x) => {
        let v = 0;
        for (const [f, p, a] of oct) {
          const s = Math.sin((x / W) * f * 6.283 + p);
          v += a * (sharp * Math.pow(1 - Math.abs(s), 1.6) + (1 - sharp) * (0.5 + 0.5 * s));
        }
        return base - amp * (v / 1.875);
      };
      const trees = t > 0.55, step = trees ? 9 : 10;
      let d = `M-100 ${H}`;
      for (let x = -100; x <= W + 100; x += step) {
        const yy = y(x);
        d += trees ? `L${x} ${yy.toFixed(1)}L${x + step / 2} ${(yy - 8 - r() * 20 * t).toFixed(1)}` : `L${x} ${yy.toFixed(1)}`;
      }
      d += `L${W + 100} ${H}Z`;
      const col = mix(m.far, m.near, Math.pow(t, 0.8));
      defs += `<linearGradient id="${id}l${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}"/><stop offset="1" stop-color="${mix(col, m.haze, 0.6 * (1 - t))}"/></linearGradient>`;
      // тропа идёт по склону предпоследнего плана
      if (o.trail && i === n - 2) {
        const pts = [];
        for (let x = W * 0.08; x <= W * 0.9; x += 30) pts.push([x, y(x) + 30 + Math.sin(x / 70) * 8]);
        trail = `<path class="trail" pathLength="1" d="M${pts.map((p) => p[0].toFixed(0) + ' ' + p[1].toFixed(1)).join('L')}" fill="none" stroke="#ffd9b8" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
          [0.22, 0.55, 0.86].map((f, k) => {
            const p = pts[Math.round(f * (pts.length - 1))];
            return `<g class="tp" style="--i:${k}"><circle cx="${p[0]}" cy="${p[1]}" r="13" fill="#ef7d6b" stroke="#fff" stroke-width="4"/></g>`;
          }).join('');
      }
      body += `<g class="ly" style="--z:${(0.12 + 0.88 * t).toFixed(2)}"><path d="${d}" fill="url(#${id}l${i})"/>${i === n - 2 ? trail : ''}</g>`;
      if (i === 1 || i === n - 3) body += `<ellipse class="mist" cx="${W * (0.3 + r() * 0.4)}" cy="${base + amp * 0.1}" rx="${W * 0.55}" ry="${H * 0.045}" fill="${m.haze}" opacity=".5" filter="url(#${id}b)"/>`;
    }
    return `<svg class="scene" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><defs>${defs}</defs>${body}</svg>`;
  }
  root.TropaScene = scene;
})(typeof window === 'undefined' ? globalThis : window);
