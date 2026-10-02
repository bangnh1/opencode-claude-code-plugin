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
  let result;
  const attempts = process.env.OCC_STARS_SOURCE === 'graphql' ? [fetchStarDatesGraphql] : [fetchStarDates, fetchStarDatesGraphql];
  for (const attempt of attempts) {
    try {
      const dates = await attempt(repo);
      if (dates.length === 0) throw new Error('no stargazers returned');
      result = { dates, source: attempt === fetchStarDates ? 'live' : 'graphql' };
      break;
    } catch (error) {
      console.warn(`[occ-docs] star history: ${attempt.name} failed (${error.message})`);
    }
  }
  result ??= { dates: [...snapshot.dates], source: 'snapshot', fetched: snapshot.fetched };
  // The plain repository endpoint answers everywhere the dates endpoint may not, so
  // the chart's end is the real count even when the dates are the snapshot's: stars
  // newer than the last known date are drawn on today.
  try {
    const total = await fetchStarCount(repo);
    const today = new Date().toISOString().slice(0, 10);
    while (result.dates.length < total) result.dates.push(today);
    result.padded = total > (result.source === 'snapshot' ? snapshot.dates.length : result.dates.length) ? total - snapshot.dates.length : 0;
  } catch (error) {
    console.warn(`[occ-docs] star history: count unavailable (${error.message})`);
  }
  console.log(`[occ-docs] star history: ${result.dates.length} stars from ${result.source}`);
  return result;
}

async function fetchStarCount(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}`, { headers: headersFor('application/json'), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`repos answered ${response.status}`);
  return (await response.json()).stargazers_count;
}

function headersFor(accept) {
  const token = process.env.GITHUB_TOKEN;
  return { accept, 'user-agent': 'occ-docs-build', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** The same dates through GraphQL, which an Actions token is allowed to use. */
async function fetchStarDatesGraphql(repo) {
  const [owner, name] = repo.split('/');
  const dates = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const query = `query($owner:String!,$name:String!,$after:String){ repository(owner:$owner,name:$name){ stargazers(first:100, after:$after, orderBy:{field:STARRED_AT, direction:ASC}){ pageInfo{ hasNextPage endCursor } edges{ starredAt } } } }`;
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headersFor('application/json'), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, name, after } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`graphql answered ${response.status}`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(body.errors[0].message);
    const stargazers = body.data.repository.stargazers;
    for (const edge of stargazers.edges) dates.push(edge.starredAt.slice(0, 10));
    if (!stargazers.pageInfo.hasNextPage) break;
    after = stargazers.pageInfo.endCursor;
  }
  return dates.sort();
}

async function fetchStarDates(repo) {
  const headers = headersFor('application/vnd.github.star+json');
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
