const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data', 'netease');
const QQ_CACHE_PATH = path.join(DATA_DIR, 'qq-recommendations.json');
const QQ_API_BASE = process.env.QQMUSIC_API_BASE || 'https://a.y.qq.com';
const QQ_API_KEY = process.env.QQMUSIC_API_KEY || '';
const SKILL_VERSION = '0.0.2';

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function callQQ(path, params = {}) {
  if (!QQ_API_KEY) throw new Error('QQMUSIC_API_KEY not set');
  const url = new URL(path, QQ_API_BASE + '/');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${QQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ params, comm: { skill_version: SKILL_VERSION } }),
  });
  if (!res.ok) throw new Error(`QQ ${path} HTTP ${res.status}`);
  return res.json();
}

async function fetchDailyMix() {
  const json = await callQQ('/discover/daily-mix');
  return (json.songlist || []).map(s => ({
    title: s.songName,
    artist: s.singerName,
  }));
}

/**
 * Refresh the daily-mix cache. Saves to user/qq-recommendations.json.
 * Returns { count, fetchedAt } or { error }.
 */
async function refreshRecommendations() {
  if (!QQ_API_KEY) {
    return { error: 'QQMUSIC_API_KEY not set' };
  }
  try {
    const list = await fetchDailyMix();
    ensureDataDir();
    const payload = {
      fetchedAt: new Date().toISOString(),
      source: 'qq-daily-mix',
      count: list.length,
      songs: list,
    };
    fs.writeFileSync(QQ_CACHE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    return { count: list.length, fetchedAt: payload.fetchedAt };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Read the cached QQ recommendations. Returns [] if none cached.
 */
function loadRecommendations() {
  try {
    const raw = JSON.parse(fs.readFileSync(QQ_CACHE_PATH, 'utf-8'));
    if (Array.isArray(raw.songs)) return raw.songs;
  } catch {}
  return [];
}

function recommendationsSummary() {
  const songs = loadRecommendations();
  if (!songs.length) return '';
  const list = songs
    .slice(0, 30)
    .map((s, i) => `${i + 1}. ${s.title} — ${s.artist}`)
    .join('\n');
  return list;
}

module.exports = {
  QQ_CACHE_PATH,
  refreshRecommendations,
  loadRecommendations,
  recommendationsSummary,
  fetchDailyMix,
};