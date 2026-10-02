/*
  When each star arrived, for the chart on the credits page. One request per
  hundred stars at build time (GitHub's `star+json` media type carries
  `starred_at`), the committed snapshot when the API is unreachable, so the page
  never shows an empty chart. Read by astro.config.mjs before the Markdown
  plugins are built, because a Sätteri hast plugin runs synchronously.
*/
import { readFileSync } from 'node:fs';

const TIMEOUT_MS = 8000;

export async function loadStarHistory({ repo, snapshotPath }) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  try {
    const dates = await fetchStarDates(repo);
    if (dates.length === 0) throw new Error('no stargazers returned');
    return { dates, source: 'live' };
  } catch (error) {
    console.warn(`[occ-docs] star history: using snapshot (${error.message})`);
    return { dates: snapshot.dates, source: 'snapshot', fetched: snapshot.fetched };
  }
}

async function fetchStarDates(repo) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    accept: 'application/vnd.github.star+json',
    'user-agent': 'occ-docs-build',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const dates = [];
  let url = `https://api.github.com/repos/${repo}/stargazers?per_page=100`;
  for (let page = 0; url && page < 20; page += 1) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    for (const entry of await response.json()) {
      if (typeof entry.starred_at === 'string') dates.push(entry.starred_at.slice(0, 10));
    }
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
  }
  return dates.sort();
}
