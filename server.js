require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const { route } = require('./router');
const { buildPrompt, buildProgramStartPrompt, buildColdOpenForTracksPrompt, buildMusicRefillPrompt, buildBridgePrompt, setCurrentUserId } = require('./context');
const { callClaude } = require('./claude');
const { synthesize } = require('./tts');
const { getTrack, likeSong } = require('./music');
const { addPlay, clearPlays, addMessage, recentPlays, getPref } = require('./state');
const scheduler = require('./scheduler');
const {
  bootstrapNeteaseLogin,
  requestNeteaseJson,
  getNeteaseConfig,
  verifyLoginStatus,
  trimCookie,
  setCurrentUserCookie,
} = require('./netease-session');
const app = express();
const server = http.createServer(app);

// Security middleware
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://p1.music.126.net", "https://p2.music.126.net", "https://p3.music.126.net", "https://p4.music.126.net"],
      mediaSrc: ["'self'", "http://*.music.126.net", "https://*.music.126.net"],
      connectSrc: ["'self'", "ws:", "wss:", "https://*.music.126.net", "http://*.music.126.net", "https://aihot.virxact.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));

const wss = new WebSocketServer({ server, path: '/stream' });

app.use(express.json());
app.use(express.text({ type: 'text/plain' }));
app.use(express.static(path.join(__dirname, 'pwa')));

// Trust proxy (Nginx) to get real client IP for rate limiting
app.set('trust proxy', 1);

// Rate limit API routes only (after static files)
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip, // use the IP from trust proxy
}));

// ── WebSocket broadcast ──────────────────────────────────────────────────────
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── Current playback state ───────────────────────────────────────────────────
let nowPlaying = null;

const STATION_NAME = 'Claudio FM';
const PROGRAM_NAME = 'Evening Drive';
const REFILL_TRACK_COUNT = 3;
const PROGRAM_START_ID_TEXT = 'This is Claudio.';
const TRACK_REPEAT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ARTIST_RECENT_WINDOW = 5;

const stationState = {
  programId: null,
  sessionTitle: '',
  tracks: [],
  generationJobs: [],
  jobKeys: new Set(),
  workerRunning: false,
};

// Current user ID for taste isolation
let currentUserId = null;

function setStationUserId(userId) {
  currentUserId = userId || null;
  setCurrentUserId(userId);
}

function getStationUserId() {
  return currentUserId;
}

function normalizeDjLanguage(value) {
  return value === 'zh' ? 'zh' : 'en';
}

function buildAnnouncement(result, tracks, failedTracks, speechOnly) {
  const firstSegmentText = result.segments?.find(s => s?.text)?.text;
  if (firstSegmentText) return firstSegmentText.trim();
  if (result.say) return result.say.trim();
  if (!speechOnly && !tracks.length && failedTracks.length) {
    return "I couldn't get a clean playable link for that set, so I'm keeping the current signal alive.";
  }
  return '';
}

function programStartIdSegment(programId) {
  return {
    id: `${programId}_station_id`,
    type: 'cold_open',
    groupId: 'open_0',
    part: 'station_id',
    partIndex: 0,
    position: 'before_track',
    trackIndex: 0,
    text: PROGRAM_START_ID_TEXT,
  };
}

function makeSegmentId(index) {
  return `seg_${Date.now()}_${index}`;
}

function normalizeSegment(raw, index, trackCount) {
  if (!raw || typeof raw !== 'object') return null;
  const allowedTypes = new Set(['cold_open', 'bridge', 'quick_touch', 'back_announce', 'silence']);
  const allowedPositions = new Set(['before_track', 'between_tracks', 'after_track', 'immediate']);
  const type = allowedTypes.has(raw.type) ? raw.type : 'quick_touch';
  const defaultPosition = type === 'bridge' ? 'between_tracks' : type === 'cold_open' ? 'before_track' : 'immediate';
  const position = allowedPositions.has(raw.position) ? raw.position : defaultPosition;
  const segment = {
    id: raw.id || makeSegmentId(index),
    type,
    position,
    text: typeof raw.text === 'string' ? raw.text.trim() : '',
    status: type === 'silence' ? 'silent' : 'pending',
  };

  if (typeof raw.groupId === 'string' && raw.groupId.trim()) segment.groupId = raw.groupId.trim();
  if (typeof raw.part === 'string' && raw.part.trim()) segment.part = raw.part.trim();
  if (Number.isInteger(raw.partIndex)) segment.partIndex = Math.max(0, raw.partIndex);
  if (Number.isInteger(raw.partCount)) segment.partCount = Math.max(1, raw.partCount);

  if (Number.isInteger(raw.trackIndex)) {
    segment.trackIndex = Math.max(0, Math.min(raw.trackIndex, Math.max(0, trackCount - 1)));
  }
  if (Number.isInteger(raw.afterTrackIndex)) {
    segment.afterTrackIndex = Math.max(0, Math.min(raw.afterTrackIndex, Math.max(0, trackCount - 1)));
  }
  if (Number.isInteger(raw.beforeTrackIndex)) {
    segment.beforeTrackIndex = Math.max(0, Math.min(raw.beforeTrackIndex, Math.max(0, trackCount - 1)));
  }

  if (position === 'before_track' && segment.trackIndex === undefined) segment.trackIndex = 0;
  if (position === 'between_tracks') {
    if (segment.afterTrackIndex === undefined) segment.afterTrackIndex = Math.max(0, (segment.beforeTrackIndex ?? index) - 1);
    if (segment.beforeTrackIndex === undefined) segment.beforeTrackIndex = Math.min(trackCount - 1, segment.afterTrackIndex + 1);
  }
  if (!trackCount && ['before_track', 'between_tracks', 'after_track'].includes(position)) {
    segment.position = 'immediate';
    delete segment.trackIndex;
    delete segment.afterTrackIndex;
    delete segment.beforeTrackIndex;
  }
  return segment;
}

function splitSentences(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const pieces = normalized.match(/[^.!?。！？]+[.!?。！？"'’”)\]]*/g);
  return (pieces || [normalized]).map(s => s.trim()).filter(Boolean);
}

function expandColdOpenParts(segments) {
  const defaultParts = ['anchor', 'heart', 'turn', 'image', 'invitation'];
  const expanded = [];

  for (const segment of segments) {
    if (segment.type !== 'cold_open' || !segment.text || segment.part) {
      expanded.push(segment);
      continue;
    }

    const sentences = splitSentences(segment.text);
    if (sentences.length <= 1) {
      expanded.push(segment);
      continue;
    }

    const groupId = segment.groupId || segment.id || makeSegmentId(expanded.length);
    sentences.forEach((text, partIndex) => {
      expanded.push({
        ...segment,
        id: `${groupId}_${partIndex}`,
        groupId,
        part: defaultParts[partIndex] || 'line',
        partIndex,
        partCount: sentences.length,
        text,
      });
    });
  }

  return expanded;
}

function normalizeSegments(result, tracks, speechOnly, failedTracks) {
  const trackCount = tracks.length;
  let segments = Array.isArray(result.segments)
    ? result.segments.map((s, i) => normalizeSegment(s, i, trackCount)).filter(Boolean)
    : [];

  if (!segments.length) {
    if (result.say) {
      segments.push(normalizeSegment({
        type: speechOnly ? 'quick_touch' : 'cold_open',
        position: speechOnly ? 'immediate' : 'before_track',
        trackIndex: 0,
        text: result.say,
      }, 0, trackCount));
    }
    if (!speechOnly && Array.isArray(result.intros)) {
      result.intros.forEach((text, i) => {
        if (i === 0 || !text) return;
        segments.push(normalizeSegment({
          type: 'bridge',
          position: 'between_tracks',
          afterTrackIndex: i - 1,
          beforeTrackIndex: i,
          text,
        }, segments.length, trackCount));
      });
    }
  }

  if (!speechOnly && !trackCount && failedTracks.length && !segments.some(s => s?.text)) {
    segments.push(normalizeSegment({
      type: 'quick_touch',
      position: 'immediate',
      text: "I couldn't get a clean playable link for that set, so I'm keeping the current signal alive.",
    }, segments.length, trackCount));
  }

  return expandColdOpenParts(segments.filter(Boolean)).map((segment, index) => ({
    ...segment,
    id: segment.id || makeSegmentId(index),
  }));
}

function getTtsVoiceForLanguage(language) {
  if (normalizeDjLanguage(language) === 'zh') {
    return {
      voiceType: process.env.VOLCENGINE_TTS_VOICE_TYPE_ZH || process.env.VOLCENGINE_TTS_VOICE_TYPE || 'zh_female_qingxinbabel_tts_common',
      resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID_ZH || process.env.VOLCENGINE_TTS_RESOURCE_ID || 'volc.service_type.10029',
    };
  }
  return {
    voiceType: process.env.VOLCENGINE_TTS_VOICE_TYPE || 'en_female_nadia_tips_emo_v2_mars_bigtts',
    resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID || 'volc.service_type.10029',
  };
}

async function synthesizeSegments(segments, djLanguage = 'en') {
  const { voiceType, resourceId } = getTtsVoiceForLanguage(djLanguage);
  const provider = process.env.TTS_PROVIDER || 'volcengine';

  // 收集所有需要合成的文本段落
  const speakableSegments = segments.filter(s => s.type !== 'silence' && s.text);
  if (!speakableSegments.length) return segments;

  // 只有 minimax 需要合并合成（解决流式响应分段重复 MP3 头导致播放两次的问题）
  // 其他 provider（volcengine/fish/kokoro）保持逐段合成，支持更灵活的播放控制
  const shouldMerge = provider === 'minimax';

  if (shouldMerge) {
    // 合并所有文本为一段，用适当停顿分隔
    const mergedText = speakableSegments.map(s => s.text).join('。');
    const mergedPreview = mergedText.slice(0, 50) + (mergedText.length > 50 ? '…' : '');
    console.log(`[TTS] 合并合成 ${speakableSegments.length} 段 (${mergedText.length} 字): "${mergedPreview}"`);

    try {
      const startAt = Date.now();
      const f = await synthesize(mergedText, { voiceType, resourceId });
      const mergedTtsUrl = '/api/tts/' + path.basename(f);
      console.log(`[TTS] 合并完成 (${((Date.now() - startAt) / 1000).toFixed(1)}s) → ${path.basename(f)}`);

      // 计算每个段落在合并文本中的时间比例（按字数比例估算）
      const totalChars = speakableSegments.reduce((sum, s) => sum + (s.text?.length || 0), 0);
      let charOffset = 0;
      const segmentRanges = speakableSegments.map(s => {
        const start = totalChars > 0 ? charOffset / totalChars : 0;
        const end = totalChars > 0 ? (charOffset + (s.text?.length || 0)) / totalChars : 0;
        charOffset += (s.text?.length || 0);
        return { id: s.id, start, end };
      });

      // 将合成的音频 URL 赋给第一个可播放段落
      let assigned = false;
      for (const segment of segments) {
        if (segment.type === 'silence' || !segment.text) {
          segment.status = 'silent';
          continue;
        }
        if (!assigned) {
          segment.ttsUrl = mergedTtsUrl;
          segment.status = 'ready';
          segment._mergedText = mergedText;
          segment._segmentRanges = segmentRanges;
          assigned = true;
        } else {
          segment.status = 'merged';
          segment.ttsUrl = null;
        }
      }
    } catch (err) {
      console.error(`[TTS] 合并合成失败:`, err.message);
      // 回退：逐段合成
      await synthesizeSegmentsIndividually(segments, voiceType, resourceId);
    }
  } else {
    // 逐段合成（volcengine/fish/kokoro 等）
    await synthesizeSegmentsIndividually(segments, voiceType, resourceId);
  }

  return segments;
}

async function synthesizeSegmentsIndividually(segments, voiceType, resourceId) {
  for (const segment of segments) {
    if (segment.type === 'silence' || !segment.text) {
      segment.status = 'silent';
      continue;
    }
    try {
      console.log(`[TTS] 合成 ${segment.type} (${segment.text.length} 字): "${segment.text.slice(0, 50)}…"`);
      const f = await synthesize(segment.text, { voiceType, resourceId });
      segment.ttsUrl = '/api/tts/' + path.basename(f);
      segment.status = 'ready';
      console.log(`[TTS] ${segment.type} 完成 → ${path.basename(f)}`);
    } catch (err) {
      segment.status = 'tts_failed';
      segment.error = err.message;
      console.error(`[TTS] ${segment.type} 合成失败:`, err.message);
    }
  }
}

function applyLegacyTrackIntrosFromSegments(tracks, segments) {
  for (const segment of segments) {
    if (!segment.ttsUrl || !segment.text) continue;
    if (segment.position === 'between_tracks' && Number.isInteger(segment.beforeTrackIndex)) {
      const track = tracks[segment.beforeTrackIndex];
      if (track && !track.introTtsUrl) {
        track.introTtsUrl = segment.ttsUrl;
        track.introTranscript = segment.text;
        track.segmentId = segment.id;
      }
    }
  }
}

function makeProgramId() {
  return `program_${Date.now()}`;
}

function callerTtsOptions() {
  return {
    role: 'caller',
    provider: process.env.CALLER_TTS_PROVIDER || process.env.TTS_PROVIDER || 'volcengine',
    apiKey: process.env.CALLER_TTS_API_KEY || process.env.VOLCENGINE_TTS_API_KEY,
    endpoint: process.env.CALLER_TTS_ENDPOINT || process.env.VOLCENGINE_TTS_ENDPOINT,
    resourceId: process.env.CALLER_TTS_RESOURCE_ID || process.env.VOLCENGINE_TTS_RESOURCE_ID,
    voiceType: process.env.CALLER_TTS_VOICE_TYPE || process.env.VOLCENGINE_TTS_VOICE_TYPE,
    voiceId: process.env.CALLER_FISH_VOICE_ID || process.env.FISH_VOICE_ID,
    voice: process.env.CALLER_KOKORO_VOICE || process.env.KOKORO_VOICE,
    model: process.env.CALLER_KOKORO_MODEL || process.env.KOKORO_MODEL,
    baseUrl: process.env.CALLER_KOKORO_API_BASE || process.env.KOKORO_API_BASE,
    format: process.env.CALLER_TTS_FORMAT || process.env.VOLCENGINE_TTS_FORMAT,
    sampleRate: process.env.CALLER_TTS_SAMPLE_RATE || process.env.VOLCENGINE_TTS_SAMPLE_RATE,
    additions: process.env.CALLER_TTS_ADDITIONS || process.env.VOLCENGINE_TTS_ADDITIONS,
  };
}

function trackLabel(track) {
  if (!track) return '';
  return `${track.title || track.query || ''}${track.artist ? ' — ' + track.artist : ''}`.trim();
}

function normalizeTrackText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trackIdentity(track) {
  const title = normalizeTrackText(track?.title || track?.query || '');
  const artist = normalizeTrackText(track?.artist || '');
  return artist ? `${title}::${artist}` : title;
}

function trackUrlIdentity(track) {
  return String(track?.streamUrl || track?.source_url || '').trim();
}

function parseRequestedTrack(query) {
  const parts = String(query || '').split(/\s+-\s+/);
  return {
    title: parts[0]?.trim() || String(query || '').trim(),
    artist: parts.slice(1).join(' - ').trim(),
  };
}

function trackMatchesRequest(requested, resolved) {
  const requestedTitle = normalizeTrackText(requested.title);
  const requestedArtist = normalizeTrackText(requested.artist);
  const resolvedTitle = normalizeTrackText(resolved.title);
  const resolvedArtist = normalizeTrackText(resolved.artist);
  if (!requestedTitle || !resolvedTitle) return true;

  const titleMatches = requestedTitle === resolvedTitle ||
    requestedTitle.includes(resolvedTitle) ||
    resolvedTitle.includes(requestedTitle);
  const artistMatches = !requestedArtist || !resolvedArtist ||
    requestedArtist === resolvedArtist ||
    requestedArtist.includes(resolvedArtist) ||
    resolvedArtist.includes(requestedArtist);

  return titleMatches && artistMatches;
}

function shouldSkipTrack(track, avoidState) {
  const identity = trackIdentity(track);
  const urlIdentity = trackUrlIdentity(track);
  const artist = normalizeTrackText(track.artist);
  if (!identity) return { skip: false };

  if (avoidState.batchTrackKeys.has(identity) || (urlIdentity && avoidState.batchUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'same batch duplicate' };
  }
  if (avoidState.queueTrackKeys.has(identity) || (urlIdentity && avoidState.queueUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'already in current queue' };
  }
  if (avoidState.cooldownTrackKeys.has(identity) || (urlIdentity && avoidState.cooldownUrlKeys.has(urlIdentity))) {
    return { skip: true, reason: 'played within 24h' };
  }
  if (artist && avoidState.recentArtistKeys.has(artist)) {
    return { skip: true, reason: `artist appeared in recent ${ARTIST_RECENT_WINDOW}` };
  }
  return { skip: false };
}

function createTrackAvoidState(extraQueue = []) {
  const queueTracks = [
    ...stationState.tracks,
    ...(Array.isArray(extraQueue) ? extraQueue : []),
  ];
  const queueTrackKeys = new Set(queueTracks.map(trackIdentity).filter(Boolean));
  const queueUrlKeys = new Set(queueTracks.map(trackUrlIdentity).filter(Boolean));
  const recent = recentPlays(50);
  const cutoff = Date.now() - TRACK_REPEAT_COOLDOWN_MS;
  const cooldownTracks = recent.filter(track => Number(track.played_at) >= cutoff);
  return {
    batchTrackKeys: new Set(),
    batchUrlKeys: new Set(),
    queueTrackKeys,
    queueUrlKeys,
    cooldownTrackKeys: new Set(cooldownTracks.map(trackIdentity).filter(Boolean)),
    cooldownUrlKeys: new Set(cooldownTracks.map(trackUrlIdentity).filter(Boolean)),
    recentArtistKeys: new Set(recent.slice(0, ARTIST_RECENT_WINDOW).map(track => normalizeTrackText(track.artist)).filter(Boolean)),
  };
}

function normalizeTracksForPrompt(tracks = []) {
  return tracks.map(track => ({
    query: track.query || trackLabel(track),
    title: track.title || track.query || '',
    artist: track.artist || '',
  }));
}

async function resolveRequestedTracks(requestedTracks, options = {}) {
  const tracks = [];
  const failedTracks = [];
  const avoidState = createTrackAvoidState(options.queue || []);
  for (let i = 0; i < requestedTracks.length; i++) {
    const query = requestedTracks[i];
    const track = await getTrack(query);
    if (track?.streamUrl) {
      const requested = parseRequestedTrack(query);
      if (!trackMatchesRequest(requested, track)) {
        failedTracks.push(`${query} (resolved mismatch: ${track.title}${track.artist ? ' — ' + track.artist : ''})`);
        console.log(`[音乐] ↷ ${i + 1}/${requestedTracks.length} 跳过错配: 请求 "${query}"，返回 "${track.title}${track.artist ? ' — ' + track.artist : ''}"`);
        continue;
      }
      const payloadTrack = {
        query,
        title: track.title || requested.title || query,
        artist: track.artist || requested.artist || '',
        streamUrl: track.streamUrl,
        id: track.id || null,
      };
      const skip = shouldSkipTrack(payloadTrack, avoidState);
      if (skip.skip) {
        failedTracks.push(`${query} (${skip.reason})`);
        console.log(`[音乐] ↷ ${i + 1}/${requestedTracks.length} 跳过重复: ${payloadTrack.title}${payloadTrack.artist ? ' — ' + payloadTrack.artist : ''} | ${skip.reason}`);
        continue;
      }
      tracks.push(payloadTrack);
      avoidState.batchTrackKeys.add(trackIdentity(payloadTrack));
      const urlIdentity = trackUrlIdentity(payloadTrack);
      if (urlIdentity) avoidState.batchUrlKeys.add(urlIdentity);
      addPlay({ title: payloadTrack.title, artist: payloadTrack.artist, source_url: payloadTrack.streamUrl });
      console.log(`[音乐] ✓ ${i + 1}/${requestedTracks.length} 找到: ${payloadTrack.title}${payloadTrack.artist ? ' — ' + payloadTrack.artist : ''}`);
    } else {
      failedTracks.push(query);
      console.log(`[音乐] ✗ ${i + 1}/${requestedTracks.length} 未找到: ${query}`);
    }
  }
  return { tracks, failedTracks };
}

function enqueueJob(job) {
  const key = job.key || `${job.type}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  if (stationState.jobKeys.has(key)) {
    console.log(`[jobs] 跳过重复任务 ${key}`);
    return false;
  }
  stationState.jobKeys.add(key);
  stationState.generationJobs.push({ ...job, key });
  console.log(`[jobs] 入队 ${key}`);
  drainJobs();
  return true;
}

async function drainJobs() {
  if (stationState.workerRunning) return;
  stationState.workerRunning = true;
  while (stationState.generationJobs.length) {
    const job = stationState.generationJobs.shift();
    try {
      // Set user ID before job execution (from job.userId or current station user)
      const jobUserId = job.userId || currentUserId;
      setStationUserId(jobUserId);
      console.log(`[jobs] 开始 ${job.key}${jobUserId ? ' (user:' + jobUserId + ')' : ''}`);
      await runJob(job);
      console.log(`[jobs] 完成 ${job.key}`);
    } catch (err) {
      console.error(`[jobs] 失败 ${job.key}:`, err.message);
      broadcast({ type: 'job-status', key: job.key, jobType: job.type, status: 'failed', error: err.message });
    } finally {
      stationState.jobKeys.delete(job.key);
    }
  }
  stationState.workerRunning = false;
}

async function runJob(job) {
  if (job.type === 'program_start') return runProgramStartJob(job);
  if (job.type === 'music_refill') return runMusicRefillJob(job);
  if (job.type === 'bridge_generation') return runBridgeGenerationJob(job);
  throw new Error(`Unknown job type: ${job.type}`);
}

function enqueueBridgeJobs({ programId, sessionTitle, tracks, startIndex = 0, previousTrack = null, previousIndex = null, djLanguage = 'en' }) {
  if (previousTrack && tracks.length) {
    enqueueJob({
      type: 'bridge_generation',
      key: `bridge:${programId}:${previousIndex}:${startIndex}`,
      programId,
      sessionTitle,
      afterTrack: previousTrack,
      beforeTrack: tracks[0],
      afterTrackIndex: previousIndex,
      beforeTrackIndex: startIndex,
      djLanguage: normalizeDjLanguage(djLanguage),
    });
  }
  for (let i = 1; i < tracks.length; i++) {
    enqueueJob({
      type: 'bridge_generation',
      key: `bridge:${programId}:${startIndex + i - 1}:${startIndex + i}`,
      programId,
      sessionTitle,
      afterTrack: tracks[i - 1],
      beforeTrack: tracks[i],
      afterTrackIndex: startIndex + i - 1,
      beforeTrackIndex: startIndex + i,
      djLanguage: normalizeDjLanguage(djLanguage),
    });
  }
}

async function runProgramStartJob(job) {
  const programId = makeProgramId();
  const prompt = buildProgramStartPrompt(job.input || 'Open the station.', job.queueState || '', {
    djLanguage: job.djLanguage,
  });
  const result = await callClaude(prompt);
  const { tracks, failedTracks } = await resolveRequestedTracks(result.play || []);
  let coldOpenSegments = (result.segments || []).filter(segment => segment?.type === 'cold_open');
  let coldOpenReason = result.reason;
  if (tracks.length) {
    const coldOpenPrompt = buildColdOpenForTracksPrompt({
      programTitle: result.title || '',
      tracks,
      userInput: job.input || 'Open the station.',
      djLanguage: job.djLanguage,
    });
    const coldOpenScript = await callClaude(coldOpenPrompt);
    coldOpenSegments = Array.isArray(coldOpenScript.segments) ? coldOpenScript.segments : coldOpenSegments;
    coldOpenReason = coldOpenScript.reason || coldOpenReason;
  }
  const coldOpenResult = {
    ...result,
    segments: [
      programStartIdSegment(programId),
      ...coldOpenSegments,
    ],
  };
  const segments = await synthesizeSegments(normalizeSegments(coldOpenResult, tracks, false, failedTracks), job.djLanguage);

  stationState.programId = programId;
  stationState.sessionTitle = result.title || '';
  stationState.tracks = tracks;
  if (tracks.length) nowPlaying = { title: tracks[0].title, artist: tracks[0].artist, startedAt: Date.now() };
  addMessage('claudio', segments.filter(s => s.text).map(s => s.text).join('\n\n'));

  const payload = {
    type: 'program-start',
    programId,
    tracks,
    segments,
    sessionTitle: result.title || '',
    stationName: STATION_NAME,
    programName: PROGRAM_NAME,
    failedTracks,
    reason: coldOpenReason,
  };
  broadcast(payload);

  enqueueBridgeJobs({ programId, sessionTitle: result.title || '', tracks, startIndex: 0, djLanguage: job.djLanguage });
  return payload;
}

async function runMusicRefillJob(job) {
  const programId = job.programId || stationState.programId || makeProgramId();
  const queue = normalizeTracksForPrompt(job.queue || stationState.tracks);
  const prompt = buildMusicRefillPrompt({
    programTitle: job.sessionTitle || stationState.sessionTitle,
    currentTrack: job.currentTrack,
    queue,
    count: job.count || REFILL_TRACK_COUNT,
  });
  const result = await callClaude(prompt);
  const { tracks, failedTracks } = await resolveRequestedTracks(result.play || [], { queue });
  const startIndex = Number.isInteger(job.queueLength) ? job.queueLength : stationState.tracks.length;
  const previousTrack = job.previousTrack || stationState.tracks[stationState.tracks.length - 1] || null;
  const previousIndex = Number.isInteger(job.previousIndex) ? job.previousIndex : startIndex - 1;

  stationState.programId = programId;
  stationState.sessionTitle = job.sessionTitle || stationState.sessionTitle || result.title || '';
  stationState.tracks = [...stationState.tracks, ...tracks];

  const payload = {
    type: 'tracks-ready',
    programId,
    tracks,
    startIndex,
    failedTracks,
    reason: result.reason,
  };
  broadcast(payload);
  enqueueBridgeJobs({ programId, sessionTitle: stationState.sessionTitle, tracks, startIndex, previousTrack, previousIndex, djLanguage: job.djLanguage });
  return payload;
}

async function runBridgeGenerationJob(job) {
  const prompt = buildBridgePrompt({
    programTitle: job.sessionTitle || stationState.sessionTitle,
    afterTrack: job.afterTrack,
    beforeTrack: job.beforeTrack,
    afterTrackIndex: job.afterTrackIndex,
    beforeTrackIndex: job.beforeTrackIndex,
    djLanguage: job.djLanguage,
  });
  const result = await callClaude(prompt);
  let segments = await synthesizeSegments(normalizeSegments(
    result,
    new Array(Math.max(job.beforeTrackIndex + 1, 1)).fill(null),
    false,
    []
  ), job.djLanguage);
  segments = segments.filter(segment =>
    segment.position === 'between_tracks' &&
    segment.afterTrackIndex === job.afterTrackIndex &&
    segment.beforeTrackIndex === job.beforeTrackIndex
  );
  if (!segments.length) {
    segments = [normalizeSegment({
      type: 'silence',
      position: 'between_tracks',
      afterTrackIndex: job.afterTrackIndex,
      beforeTrackIndex: job.beforeTrackIndex,
      text: '',
    }, 0, job.beforeTrackIndex + 1)];
  }
  broadcast({
    type: 'segment-ready',
    programId: job.programId || stationState.programId,
    segments,
  });
  if (segments.some(s => s.text)) addMessage('claudio', segments.filter(s => s.text).map(s => s.text).join('\n\n'));
  return segments;
}

// ── Radio engine — core segment runner ───────────────────────────────────────
async function runRadioSegment(userInput, intent = {}, skipHistory = false) {
  const src = intent.source || 'user';
  console.log(`\n[电台] ── 节目段开始 ── 来源: ${src}`);
  console.log(`[电台] 输入: "${userInput.slice(0, 80)}${userInput.length > 80 ? '…' : ''}"`);

  if (!skipHistory) addMessage('user', userInput);
  const prompt = buildPrompt(userInput, nowPlaying ? JSON.stringify(nowPlaying) : '', {
    mode: intent.mode,
    djLanguage: intent.djLanguage,
  });
  const speechOnly = intent.mode === 'speech-only';
  const result = await callClaude(prompt);

  console.log(`[电台] Claude 回复 → 节目「${result.title || '无标题'}」| 请求曲目 ${result.play?.length || 0} 首`);
  if (result.segments?.length) console.log(`[电台] 脚本段落: ${result.segments.length}`);
  if (result.say) console.log(`[电台] 兼容旁白: "${result.say.slice(0, 100)}${result.say.length > 100 ? '…' : ''}"`);

  const requestedTracks = speechOnly ? [] : (result.play || []);
  const { tracks, failedTracks } = await resolveRequestedTracks(requestedTracks);

  const segments = await synthesizeSegments(normalizeSegments(result, tracks, speechOnly, failedTracks), intent.djLanguage);
  applyLegacyTrackIntrosFromSegments(tracks, segments);
  const firstPlayableSegment = segments.find(s => s.ttsUrl && s.text && s.type !== 'silence');
  const announcement = buildAnnouncement({ ...result, segments }, tracks, failedTracks, speechOnly);
  const spokenSummary = segments.filter(s => s.text).map(s => s.text).join('\n\n');
  addMessage('claudio', spokenSummary || announcement || result.say || '');
  const ttsUrl = firstPlayableSegment?.ttsUrl || null;

  if (tracks.length) {
    nowPlaying = { title: tracks[0].title, artist: tracks[0].artist, startedAt: Date.now() };
  }

  const payload = {
    type: 'now-playing',
    ttsUrl,
    tracks,
    segments,
    sessionTitle: result.title || '',
    transcript: announcement,
    djNote: result.say,
    reason: result.reason,
    mode: speechOnly ? 'speech-only' : 'music',
    status: speechOnly ? 'speaking' : (tracks.length ? 'queued' : 'speaking'),
    stationName: STATION_NAME,
    programName: PROGRAM_NAME,
    trigger: intent.source || 'user',
    failedTracks,
  };

  broadcast(payload);
  console.log(`[电台] ── 广播完成 ── 入队 ${tracks.length} 首 | 失败 ${failedTracks.length} 首\n`);
  return payload;
}

async function handleClaudeRequest(userInput, res, intent = {}, skipHistory = false) {
  try {
    const payload = await runRadioSegment(userInput, intent, skipHistory);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (err) {
    console.error('[chat]', err);
    res.status(500).json({ error: err.message });
  }
}

// ── HTTP Routes ──────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, autoRefill, djLanguage } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const intent = route(message);
  intent.source = autoRefill ? 'autoRefill' : 'user';
  intent.djLanguage = normalizeDjLanguage(djLanguage);

  // Get user ID from cookie for taste isolation
  const cookie = req.headers['x-netease-cookie'];
  let userId = null;
  if (cookie) {
    try {
      const status = await verifyLoginStatus({ cookie: trimCookie(cookie) });
      if (status.userId) {
        userId = status.userId;
        setStationUserId(userId);
      }
    } catch (err) {
      console.warn('[api/chat] Failed to verify user:', err.message);
    }
  }

  if (intent.action === 'next') {
    broadcast({ type: 'control', action: 'next' });
    return res.json({ action: 'next' });
  }
  if (intent.action === 'pause') {
    broadcast({ type: 'control', action: 'pause' });
    return res.json({ action: 'pause' });
  }
  if (intent.action === 'resume') {
    broadcast({ type: 'control', action: 'resume' });
    return res.json({ action: 'resume' });
  }
  if (intent.action === 'volume') {
    broadcast({ type: 'control', action: 'volume', delta: intent.delta });
    return res.json({ action: 'volume', delta: intent.delta });
  }

  if (intent.mode !== 'speech-only') {
    enqueueJob({
      type: 'program_start',
      key: `program_start:${Date.now()}`,
      input: intent.message,
      source: autoRefill ? 'autoRefill' : 'user',
      djLanguage: intent.djLanguage,
      userId,
    });
    return res.json({ queued: true, jobType: 'program_start' });
  }

  await handleClaudeRequest(intent.message, res, intent, !!autoRefill);
});

app.post('/api/radio/refill', async (req, res) => {
  const {
    programId,
    sessionTitle,
    currentTrack,
    previousTrack,
    previousIndex,
    queue = [],
    queueLength,
    djLanguage,
  } = req.body || {};

  // Get user ID from cookie for taste isolation
  const cookie = req.headers['x-netease-cookie'];
  let userId = null;
  if (cookie) {
    try {
      const status = await verifyLoginStatus({ cookie: trimCookie(cookie) });
      if (status.userId) {
        userId = status.userId;
      }
    } catch (err) {
      console.warn('[api/radio/refill] Failed to verify user:', err.message);
    }
  }

  const effectiveProgramId = programId || stationState.programId || makeProgramId();
  const effectiveQueueLength = Number.isInteger(queueLength) ? queueLength : Array.isArray(queue) ? queue.length : stationState.tracks.length;
  const key = `music_refill:${effectiveProgramId}`;
  const accepted = enqueueJob({
    type: 'music_refill',
    key,
    programId: effectiveProgramId,
    sessionTitle: sessionTitle || stationState.sessionTitle,
    currentTrack,
    previousTrack,
    previousIndex,
    queue: Array.isArray(queue) ? queue : [],
    queueLength: effectiveQueueLength,
    count: REFILL_TRACK_COUNT,
    djLanguage: normalizeDjLanguage(djLanguage),
    userId,
  });
  res.json({ queued: accepted, jobType: 'music_refill', programId: effectiveProgramId });
});

app.get('/api/now', (req, res) => {
  res.json(nowPlaying || { playing: false });
});

app.get('/api/next', async (req, res) => {
  broadcast({ type: 'control', action: 'next' });
  res.json({ action: 'next' });
});

// Helper: get user-specific taste file path
const DEFAULT_TASTE_PATH = path.join(__dirname, 'user', 'taste.md');
const USER_TASTE_DIR = path.join(__dirname, 'data', 'netease', 'taste');

function ensureUserTasteDir() {
  fs.mkdirSync(USER_TASTE_DIR, { recursive: true });
}

function getUserTastePath(userId) {
  if (!userId) return DEFAULT_TASTE_PATH;
  ensureUserTasteDir();
  return path.join(USER_TASTE_DIR, `${userId}_taste.md`);
}

async function getUserIdFromCookie(req) {
  const cookie = req.headers['x-netease-cookie'];
  if (!cookie) return null;
  try {
    const status = await verifyLoginStatus({ cookie: trimCookie(cookie) });
    return status.userId || null;
  } catch {
    return null;
  }
}

app.get('/api/taste', async (req, res) => {
  try {
    const userId = await getUserIdFromCookie(req);
    const tastePath = getUserTastePath(userId);

    // If user-specific taste exists, return it
    if (fs.existsSync(tastePath)) {
      const content = fs.readFileSync(tastePath, 'utf-8');
      return res.type('text/plain').send(content);
    }

    // Fall back to default taste.md (as template)
    if (fs.existsSync(DEFAULT_TASTE_PATH)) {
      const content = fs.readFileSync(DEFAULT_TASTE_PATH, 'utf-8');
      return res.type('text/plain').send(content);
    }

    res.status(404).json({ error: 'taste.md not found' });
  } catch (err) {
    console.error('[taste] Get failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/taste', async (req, res) => {
  try {
    const userId = await getUserIdFromCookie(req);
    if (!userId) {
      return res.status(401).json({ error: '请先登录网易云音乐' });
    }

    const content = req.body;
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content must be a non-empty string' });
    }

    const tastePath = getUserTastePath(userId);
    fs.writeFileSync(tastePath, content, 'utf-8');
    res.json({ ok: true, userId });
  } catch (err) {
    console.error('[taste] Save failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/qq-music/refresh', async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey required' });
  }

  try {
    // Temporarily override env var for this request
    const originalKey = process.env.QQMUSIC_API_KEY;
    process.env.QQMUSIC_API_KEY = apiKey;

    const result = await refreshRecommendations();

    // Restore original env var
    if (originalKey) {
      process.env.QQMUSIC_API_KEY = originalKey;
    } else {
      delete process.env.QQMUSIC_API_KEY;
    }

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ count: result.count, fetchedAt: result.fetchedAt });
  } catch (err) {
    console.error('[qq-music] Refresh failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/plan/today', (req, res) => {
  const plan = getPref('today_plan');
  res.json(plan || { message: '今日计划尚未生成' });
});

app.post('/api/tts/caller', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 800) return res.status(400).json({ error: 'text too long' });

  try {
    const f = await synthesize(text, callerTtsOptions());
    res.json({ ttsUrl: '/api/tts/' + path.basename(f) });
  } catch (err) {
    console.error('[caller-tts]', err);
    res.status(500).json({ error: err.message });
  }
});

// AIHOT proxy endpoint - forwards requests to aihot.virxact.com
app.get('/api/aihot', async (req, res) => {
  try {
    const response = await fetch('https://aihot.virxact.com/api/public/items?mode=selected&take=10', {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[aihot-proxy]', err);
    res.status(500).json({ error: err.message });
  }
});

// AIHOT TTS endpoint - uses MiniMax with podcast-style voice
app.post('/api/tts/aihot', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 3000) return res.status(400).json({ error: 'text too long (max 3000 chars)' });

  try {
    // Use MiniMax TTS with podcast voice settings
    const f = await synthesize(text, {
      provider: 'minimax',
      voiceId: process.env.MINIMAX_TTS_VOICE_ID || 'Chinese (Mandarin)_Radio_Host',
      lang: req.body?.lang === 'zh' ? 'zh' : 'en',
    });
    res.json({ ttsUrl: '/api/tts/' + path.basename(f) });
  } catch (err) {
    console.error('[aihot-tts]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/favorite', async (req, res) => {
  const { songId, title, artist } = req.body || {};
  if (!songId) return res.status(400).json({ error: 'songId required' });
  try {
    const ok = await likeSong(songId);
    console.log('[收藏] ' + (ok ? 'ok' : 'fail') + ' ' + (title || songId));
    res.json({ ok, title, artist });
  } catch (err) {
    console.error('[收藏]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/plays/clear', (req, res) => {
  try {
    const result = clearPlays();
    console.log(`[plays] 清空历史: 删除 ${result.deleted} 条`);
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    console.error('[plays] clear failed:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── Netease QR Login API (frontend) ─────────────────────────────────────────
const QR_POLL_INTERVAL_MS = 2500;
const QR_LOGIN_TIMEOUT_MS = 180000;

app.post('/api/netease/qr/key', async (req, res) => {
  try {
    const { baseUrl } = getNeteaseConfig();
    const keyData = await requestNeteaseJson('/login/qr/key', {}, { baseUrl });
    const key = keyData?.data?.unikey;
    if (!key) {
      return res.status(500).json({ error: 'Failed to get QR key from Netease API' });
    }

    const qrData = await requestNeteaseJson('/login/qr/create', { key, qrimg: true }, { baseUrl });
    res.json({
      key,
      qrImg: qrData?.data?.qrimg || null,
      qrUrl: qrData?.data?.qrurl || null,
    });
  } catch (err) {
    console.error('[netease-qr/key]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/netease/qr/check/:key', async (req, res) => {
  const { key } = req.params;
  if (!key) return res.status(400).json({ error: 'key required' });

  try {
    const { baseUrl } = getNeteaseConfig();
    const state = await requestNeteaseJson('/login/qr/check', { key }, { baseUrl });
    const code = Number(state?.code);

    const messages = {
      800: '二维码已过期，请重新获取',
      801: '请使用网易云音乐 App 扫码',
      802: '已扫码，请在 App 中确认登录',
      803: '登录成功',
    };

    res.json({
      code,
      message: messages[code] || `未知状态: ${code}`,
      cookie: code === 803 ? trimCookie(state.cookie) : null,
    });
  } catch (err) {
    console.error('[netease-qr/check]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/netease/status', async (req, res) => {
  const userCookie = req.headers['x-netease-cookie'];
  const { baseUrl } = getNeteaseConfig();

  if (!userCookie) {
    return res.json({ loggedIn: false });
  }

  try {
    const status = await verifyLoginStatus({ baseUrl, cookie: trimCookie(userCookie) });
    res.json({
      loggedIn: status.valid,
      userId: status.userId || null,
      reason: status.reason || null,
    });
  } catch (err) {
    console.error('[netease-status]', err.message);
    res.json({ loggedIn: false, error: err.message });
  }
});


app.post('/api/netease/login', (req, res) => {
  const { cookie } = req.body;
  if (!cookie) return res.status(400).json({ error: 'cookie required' });

  setCurrentUserCookie(cookie);
  console.log('[netease-login] User cookie set via API');
  res.json({ ok: true });
});

app.post('/api/netease/logout', (req, res) => {
  // Client-side handles cookie clearing via localStorage
  // This endpoint exists for future server-side session support
  res.json({ ok: true });
});

// Serve cached TTS files
const SAFE_TTS_FILENAME = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/;
app.get('/api/tts/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!SAFE_TTS_FILENAME.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const file = path.join(__dirname, 'cache/tts', filename);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// ── Boot ─────────────────────────────────────────────────────────────────────
const { refreshRecommendations } = require('./qq-music');
const cron = require('node-cron');

scheduler.init(broadcast, runRadioSegment);

// 启动时尝试网易云登录引导
(async () => {
  try {
    const loginResult = await bootstrapNeteaseLogin();
    if (loginResult.ok) {
      console.log(`[netease-login] 登录成功，来源: ${loginResult.source}`);
    } else {
      console.log(`[netease-login] 未登录，将以匿名模式使用网易云 API`);
    }
  } catch (err) {
    console.warn('[netease-login] 登录引导失败:', err.message);
  }

  // 启动时拉一次 QQ 推荐(失败也不影响主服务)
  try {
    const r = await refreshRecommendations();
    if (r.error) console.warn('[qq-recommend] 跳过:', r.error);
    else console.log(`[qq-recommend] 拉取 ${r.count} 首到 data/netease/qq-recommendations.json`);
  } catch (err) {
    console.warn('[qq-recommend] 启动拉取失败:', err.message);
  }
})();

// 每天 9 点刷新一次 QQ 每日推荐
cron.schedule('0 9 * * *', async () => {
  try {
    const r = await refreshRecommendations();
    if (r.error) console.warn('[qq-recommend] 定时刷新失败:', r.error);
    else console.log(`[qq-recommend] 定时刷新 ${r.count} 首`);
  } catch (err) {
    console.warn('[qq-recommend] 定时刷新异常:', err.message);
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`\n[电台] Claudio FM 启动 → http://localhost:${PORT}`);
  console.log(`[电台] 等待调度器或用户触发…\n`);
});
