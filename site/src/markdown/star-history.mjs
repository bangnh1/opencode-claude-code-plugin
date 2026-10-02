/*
  The credits page embeds star-history.com's chart as a <picture>, which is right
  for GitHub's renderer and wrong here: it picks dark or light by the visitor's OS,
  not by the site's theme toggle, so a dark site over a light OS got a white chart.
  On the site that anchor becomes an inline SVG drawn from the real stargazer
  dates at build time, in the site's type, coloured by CSS variables, so it follows
  the theme like everything else and makes no third-party request.
*/
const W = 800;
const H = 300;
const PAD = { top: 28, right: 64, bottom: 36, left: 44 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const h = (tagName, properties = {}, children = []) => ({ type: 'element', tagName, properties, children });
const text = (value) => ({ type: 'text', value: String(value) });

/**
 * @param {object} options
 * @param {string[]} options.dates ISO days, one per star, sorted ascending
 * @param {string} options.source 'live' or 'snapshot'
 * @param {string} options.repoUrl the repository's GitHub URL
 */
export function starHistory({ dates, source, repoUrl }) {
  return {
    name: 'occ-star-history',
    element: {
      filter: ['a'],
      visit(node) {
        const href = node.properties?.href;
        if (typeof href !== 'string' || !href.startsWith('https://www.star-history.com/')) return;
        return chart(dates, source, repoUrl);
      },
    },
  };
}

function chart(dates, source, repoUrl) {
  const total = dates.length;
  if (total === 0) return undefined;
  const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const first = day(dates[0]);
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const last = Math.max(day(dates[dates.length - 1]), today);
  const span = Math.max(1, last - first);
  const x = (t) => PAD.left + ((t - first) / span) * (W - PAD.left - PAD.right);
  const yMax = niceCeil(total);
  const y = (count) => H - PAD.bottom - (count / yMax) * (H - PAD.top - PAD.bottom);

  // Cumulative count per distinct day, then a step line through them.
  const points = [];
  let count = 0;
  for (let i = 0; i < dates.length; i += 1) {
    count += 1;
    if (dates[i + 1] === dates[i]) continue;
    points.push([x(day(dates[i])), y(count)]);
  }
  points.push([x(last), y(total)]);
  const d = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const area = `${d} L${x(last).toFixed(1)} ${y(0).toFixed(1)} L${points[0][0].toFixed(1)} ${y(0).toFixed(1)} Z`;

  // Month ticks: the first of each month inside the range.
  const ticks = [];
  const cursor = new Date(first);
  cursor.setUTCDate(1);
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  while (cursor.getTime() <= last) {
    ticks.push(h('g', { class: 'occ-stars__tick' }, [
      h('line', { x1: x(cursor.getTime()).toFixed(1), x2: x(cursor.getTime()).toFixed(1), y1: PAD.top, y2: H - PAD.bottom, class: 'occ-stars__grid' }),
      h('text', { x: x(cursor.getTime()).toFixed(1), y: H - PAD.bottom + 18, 'text-anchor': 'middle' }, [text(MONTHS[cursor.getUTCMonth()])]),
    ]));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const yTicks = [];
  for (let v = yMax / 4; v <= yMax; v += yMax / 4) {
    yTicks.push(h('g', {}, [
      h('line', { x1: PAD.left, x2: W - PAD.right, y1: y(v).toFixed(1), y2: y(v).toFixed(1), class: 'occ-stars__grid' }),
      h('text', { x: PAD.left - 8, y: (y(v) + 4).toFixed(1), 'text-anchor': 'end' }, [text(Math.round(v))]),
    ]));
  }

  const since = `${MONTHS[new Date(first).getUTCMonth()]} ${new Date(first).getUTCFullYear()}`;
  const label = `${total} GitHub stars since ${since}`;
  const [ex, ey] = points[points.length - 1];
  return h('figure', { class: 'occ-stars not-content' }, [
    h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid meet' }, [
      ...yTicks,
      ...ticks,
      h('line', { x1: PAD.left, x2: W - PAD.right, y1: y(0).toFixed(1), y2: y(0).toFixed(1), class: 'occ-stars__axis' }),
      h('path', { d: area, class: 'occ-stars__area' }),
      h('path', { d, class: 'occ-stars__line' }),
      h('circle', { cx: ex.toFixed(1), cy: ey.toFixed(1), r: 4.5, class: 'occ-stars__end' }),
      h('text', { x: (ex + 10).toFixed(1), y: (ey + 4).toFixed(1), class: 'occ-stars__total' }, [text(total)]),
    ]),
    h('figcaption', {}, [
      h('span', { class: 'occ-stars__bar', 'aria-hidden': 'true' }),
      text(`${label}. `),
      h('a', { href: `${repoUrl}/stargazers` }, [text('The stargazers on GitHub')]),
      text(source === 'live' ? '. Drawn at build time from each star’s date.' : '. From the committed snapshot; the API was not reachable at build time.'),
    ]),
  ]);
}

function niceCeil(n) {
  const steps = [20, 40, 50, 100, 200, 250, 400, 500, 1000, 2000, 2500, 5000, 10000];
  return steps.find((s) => s >= n * 1.08) ?? Math.ceil(n * 1.1 / 1000) * 1000;
}
