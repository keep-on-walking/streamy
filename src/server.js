/**
 * Streamy — Node.js/Express Backend
 * Touch-friendly jukebox music player streaming from YouTube Music
 * + RTSP video/visualisation stream for external displays
 */

'use strict';

const express          = require('express');
const cors             = require('cors');
const http             = require('http');
const WebSocket        = require('ws');
const path             = require('path');
const { exec, spawn }  = require('child_process');
const NodeCache        = require('node-cache');
const { RTSPManager, getLocalIP } = require('./rtsp');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const cache  = new NodeCache({ stdTTL: 600 });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── In-memory State ──────────────────────────────────────────────────────────
let queue = [];
let currentTrack = null;
let playbackState = { playing: false, position: 0, volume: 80, shuffle: false, repeat: 'none' };

// ─── RTSP Manager ─────────────────────────────────────────────────────────────
const rtsp = new RTSPManager({
  rtspPort: parseInt(process.env.RTSP_PORT   || '8554'),
  width:    parseInt(process.env.RTSP_WIDTH  || '1280'),
  height:   parseInt(process.env.RTSP_HEIGHT || '720'),
  bitrate:  process.env.RTSP_BITRATE || '2M',
});

const RTSP_ENABLED = process.env.RTSP_ENABLED !== 'false';

if (RTSP_ENABLED) {
  rtsp.init().catch(err =>
    console.warn('[RTSP] Could not start:', err.message, '— set RTSP_ENABLED=false to disable')
  );
  rtsp.on('streamStart', ({ mode, track }) =>
    broadcast('rtspStatus', { ...rtsp.getStatus(), mode, track })
  );
  rtsp.on('streamStop', () => broadcast('rtspStatus', rtsp.getStatus()));
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ event: 'state', data: { queue, currentTrack, playbackState, rtsp: rtsp.getStatus() } }));
  ws.on('message', raw => {
    try { const { action, payload } = JSON.parse(raw); handleAction(action, payload); } catch {}
  });
});

function handleAction(action, payload) {
  const actions = {
    play:            () => play(),
    pause:           () => pause(),
    next:            () => next(),
    prev:            () => prev(),
    setVolume:       () => setVolume(payload.volume),
    seek:            () => seek(payload.position),
    toggleShuffle:   () => toggleShuffle(),
    cycleRepeat:     () => cycleRepeat(),
    removeFromQueue: () => removeFromQueue(payload.index),
    reorderQueue:    () => reorderQueue(payload.from, payload.to),
    playNow:         () => playNow(payload.track),
    clearQueue:      () => clearQueue(),
  };
  actions[action]?.();
}

// ─── Search ───────────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });
  const cacheKey = `search:${q}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const cmd = `yt-dlp "ytsearch10:${q.replace(/"/g, '\\"')}" --flat-playlist --dump-single-json --no-warnings 2>/dev/null`;
  exec(cmd, { timeout: 15000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Search failed' });
    try {
      const raw = JSON.parse(stdout);
      const results = (raw.entries || []).map(e => ({
        id: e.id, videoId: e.id, title: e.title,
        artist: e.uploader || e.channel || 'Unknown',
        duration: e.duration,
        thumbnail: e.thumbnails?.[e.thumbnails.length - 1]?.url
                   || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
      }));
      cache.set(cacheKey, { results });
      res.json({ results });
    } catch { res.status(500).json({ error: 'Parse error' }); }
  });
});

// ─── Audio Stream ─────────────────────────────────────────────────────────────
app.get('/api/stream/:videoId', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ytdlp = spawn('yt-dlp', [
    '--no-playlist', '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--audio-format', 'mp3', '-o', '-', '--no-warnings',
    `https://www.youtube.com/watch?v=${req.params.videoId}`,
  ]);
  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on('data', () => {});
  req.on('close', () => ytdlp.kill());
  ytdlp.on('error', () => { if (!res.headersSent) res.status(500).end(); });
});

// ─── Lyrics ───────────────────────────────────────────────────────────────────
app.get('/api/lyrics', async (req, res) => {
  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const cacheKey = `lyrics:${title}:${artist}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const axios = require('axios');
  try {
    const r = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`)}`, { timeout: 5000 });
    if (r.data?.length) {
      const m = r.data[0];
      const result = { synced: m.syncedLyrics || null, plain: m.plainLyrics || null, hasSynced: !!m.syncedLyrics };
      cache.set(cacheKey, result); return res.json(result);
    }
  } catch {}
  try {
    const r = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist||'_')}/${encodeURIComponent(title)}`, { timeout: 5000 });
    if (r.data?.lyrics) {
      const result = { synced: null, plain: r.data.lyrics, hasSynced: false };
      cache.set(cacheKey, result); return res.json(result);
    }
  } catch {}
  res.json({ synced: null, plain: null, hasSynced: false });
});

// ─── Queue REST ───────────────────────────────────────────────────────────────
app.get ('/api/queue',            (req, res) => res.json({ queue, currentTrack, playbackState }));
app.post('/api/queue/add',        (req, res) => {
  const t = req.body; if (!t?.videoId) return res.status(400).json({ error: 'Invalid' });
  queue.push({ ...t, queueId: Date.now() + Math.random() });
  broadcast('queueUpdate', { queue }); res.json({ success: true });
});
app.post('/api/queue/playnow',    (req, res) => {
  const t = req.body; if (!t?.videoId) return res.status(400).json({ error: 'Invalid' });
  playNow(t); res.json({ success: true });
});
app.delete('/api/queue/:index',   (req, res) => {
  removeFromQueue(parseInt(req.params.index)); res.json({ success: true });
});

// ─── RTSP API ─────────────────────────────────────────────────────────────────
app.get('/api/rtsp', (req, res) => res.json(rtsp.getStatus()));

app.post('/api/rtsp/stream', (req, res) => {
  const { videoId, title, artist } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  if (RTSP_ENABLED) rtsp.streamTrack({ videoId, title, artist });
  res.json({ success: true, ...rtsp.getStatus() });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  exec('yt-dlp --version', (e1, v1) =>
    exec('ffmpeg -version 2>&1 | head -1', (e2, v2) =>
      res.json({ status: 'ok', ytdlp: e1 ? 'not found' : v1.trim(), ffmpeg: e2 ? 'not found' : v2.trim(), rtsp: rtsp.getStatus() })
    )
  );
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ─── Playback Helpers ─────────────────────────────────────────────────────────
function play()  { playbackState.playing = true;  broadcast('playbackState', playbackState); }
function pause() { playbackState.playing = false; broadcast('playbackState', playbackState); }
function next()  {
  if (playbackState.shuffle && queue.length > 1) {
    currentTrack = queue.splice(Math.floor(Math.random() * queue.length), 1)[0];
  } else if (queue.length > 0) {
    currentTrack = queue.shift();
  } else {
    currentTrack = null; playbackState.playing = false;
    if (RTSP_ENABLED) rtsp.stopStream();
  }
  if (currentTrack && RTSP_ENABLED) rtsp.streamTrack(currentTrack);
  broadcast('trackChange', { currentTrack, queue, playbackState });
}
function prev() { broadcast('trackChange', { currentTrack, queue, playbackState }); }
function setVolume(v) { playbackState.volume = Math.max(0, Math.min(100, v)); broadcast('playbackState', playbackState); }
function seek(p) { playbackState.position = p; broadcast('playbackState', playbackState); }
function toggleShuffle() { playbackState.shuffle = !playbackState.shuffle; broadcast('playbackState', playbackState); }
function cycleRepeat() {
  const m = ['none','one','all'];
  playbackState.repeat = m[(m.indexOf(playbackState.repeat)+1)%3];
  broadcast('playbackState', playbackState);
}
function removeFromQueue(i) { if (i>=0&&i<queue.length) queue.splice(i,1); broadcast('queueUpdate', { queue }); }
function reorderQueue(f,t) {
  if (f>=0&&t>=0&&f<queue.length&&t<queue.length) { const[x]=queue.splice(f,1); queue.splice(t,0,x); }
  broadcast('queueUpdate', { queue });
}
function playNow(track) {
  if (!track) return;
  currentTrack = track; playbackState.playing = true;
  if (RTSP_ENABLED) rtsp.streamTrack(track);
  broadcast('trackChange', { currentTrack, queue, playbackState });
}
function clearQueue() { queue = []; broadcast('queueUpdate', { queue }); }

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n🎵  Streamy  →  http://${ip}:${PORT}`);
  console.log(`    Local:       http://localhost:${PORT}\n`);
});

process.on('SIGTERM', () => { rtsp.destroy(); process.exit(0); });
process.on('SIGINT',  () => { rtsp.destroy(); process.exit(0); });
