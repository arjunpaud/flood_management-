/* Aggregator for the रसुवा–भोटेकोशी बाढी bulletin clone.
 *
 * Reads every external source named in data/feeds.json and writes a single
 * data/live.json that the page prefers over its own in-browser fetching.
 * Server-side, so the news RSS needs no CORS proxy.
 *
 *   node scripts/fetch-sources.mjs
 *
 * Node 18+ (global fetch). No dependencies — a tiny regex RSS reader is
 * enough for the handful of feeds involved, and it keeps CI installs at zero.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = 25_000;
const PER_FEED = 15;
const INCIDENT_DAYS = 21;

const WATER_HAZARDS = new Set([11, 17, 28, 26, 3, 14, 5, 7]);

const RIVER_PATTERNS = [
  /trishuli/i, /narayani/i, /bhote\s*koshi/i, /tadi/i, /betrawati/i,
  /devghat/i, /east rapti/i, /manahari/i, /lothar/i, /budhi gandaki/i
];

/* ── fetch helpers ──────────────────────────────────────── */

async function get(url, as = 'text') {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'user-agent': 'rasuwa-flood-bulletin-clone/1.0 (+aggregator)' }
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'json' ? res.json() : res.text();
}

/* ── minimal RSS/Atom reader ────────────────────────────── */

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function parseFeed(xml, feed, keywords) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  const out = [];

  for (const b of blocks) {
    const title = tag(b, 'title');
    if (!title) continue;

    let link = tag(b, 'link');
    if (!link) {
      const href = b.match(/<link[^>]*href="([^"]+)"/i);
      link = href ? href[1] : '';
    }

    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated');
    const hay = `${title} ${link}`.toLowerCase();
    if (keywords.length && !keywords.some((k) => hay.includes(k))) continue;

    out.push({
      source: feed.name,
      sourceId: feed.id,
      site: feed.site,
      title,
      link,
      date,
      ts: date ? (Date.parse(date) || 0) : 0
    });
    if (out.length >= PER_FEED) break;
  }
  return out;
}

/* ── BIPAD portal ───────────────────────────────────────── */

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function bipadIncidents(base) {
  const url = `${base}incident/?limit=400&ordering=-incident_on&incident_on__gt=${daysAgo(INCIDENT_DAYS)}`;
  const data = await get(url, 'json');
  return (data.results || []).filter((r) => WATER_HAZARDS.has(r.hazard));
}

async function bipadRivers(base) {
  const data = await get(`${base}river/?limit=400&ordering=-id`, 'json');
  const seen = new Set();
  const out = [];
  for (const r of data.results || []) {
    if (seen.has(r.title)) continue;          /* newest row per station wins */
    seen.add(r.title);
    if (RIVER_PATTERNS.some((p) => p.test(r.title || ''))) out.push(r);
  }
  return out;
}

async function bipadAlerts(base) {
  const data = await get(`${base}alert/?limit=120&ordering=-created_on`, 'json');
  return (data.results || []).filter((a) => a.public);
}

/* ── main ───────────────────────────────────────────────── */

const settled = async (label, p) => {
  try {
    return { label, ok: true, value: await p };
  } catch (err) {
    console.warn(`  ! ${label}: ${err.message}`);
    return { label, ok: false, value: null, error: err.message };
  }
};

async function main() {
  const feeds = JSON.parse(await readFile(join(ROOT, 'data', 'feeds.json'), 'utf8'));
  const keywords = (feeds.keywords || []).map((k) => k.toLowerCase());
  const apiUrl = feeds.api?.[0]?.url || '';
  const base = apiUrl.includes('api/v1/')
    ? apiUrl.split('api/v1/')[0] + 'api/v1/'
    : 'https://bipadportal.gov.np/api/v1/';

  console.log('reading news feeds…');
  const newsResults = await Promise.all(
    (feeds.rss || []).map((f) =>
      settled(f.name, get(f.url).then((xml) => parseFeed(xml, f, keywords))))
  );

  console.log('reading BIPAD portal…');
  const [incidents, rivers, alerts] = await Promise.all([
    settled('incidents', bipadIncidents(base)),
    settled('rivers', bipadRivers(base)),
    settled('alerts', bipadAlerts(base))
  ]);

  const news = newsResults
    .filter((r) => r.ok)
    .flatMap((r) => r.value)
    .sort((a, b) => b.ts - a.ts);

  const payload = {
    generatedAt: new Date().toISOString(),
    news,
    incidents: incidents.value || [],
    rivers: rivers.value || [],
    alerts: alerts.value || [],
    health: [
      ...newsResults.map((r) => ({ source: r.label, ok: r.ok, count: r.value?.length ?? 0 })),
      ...[incidents, rivers, alerts].map((r) => ({
        source: r.label, ok: r.ok, count: r.value?.length ?? 0
      }))
    ]
  };

  await writeFile(join(ROOT, 'data', 'live.json'), JSON.stringify(payload, null, 1), 'utf8');

  console.log(
    `\nwrote data/live.json — ${news.length} headlines, ` +
    `${payload.incidents.length} incidents, ${payload.rivers.length} gauges, ` +
    `${payload.alerts.length} alerts`
  );

  if (!news.length && !payload.incidents.length) {
    console.error('every source failed — leaving a non-zero exit for CI');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
