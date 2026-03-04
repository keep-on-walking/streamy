/**
 * Streamy — Backend Server v3.0
 *
 * Jukebox architecture: all playback happens server-side via mpv.
 * Remote devices (master + user controllers) are pure web UIs.
 */
'use strict';

const express         = require('express');
const cors            = require('cors');
const http            = require('http');
const WebSocket       = require('ws');
const path            = require('path');
const fs              = require('fs');
const { exec, spawn } = require('child_process');
const NodeCache       = require('node-cache');
const multer          = require('multer');

const { Player, getLocalIP } = require('./player');
const {
  loadConfig, saveConfig, getCookieArgs,
  testBrowserCookies, testCookieFile, testOAuth2,
  fetchLikedSongs, detectBrowsers,
  startOAuth2Flow, cancelOAuth2Flow, getOAuthState,
  COOKIES_PATH,
} = require('./settings');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const cache  = new NodeCache({ stdTTL: 600 });

const TMP_DIR = path.join(__dirname, '../tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Config & State ───────────────────────────────────────────────────────────
let config = loadConfig();
let queue  = [];
let currentTrack  = null;
let playbackState = {
  playing: false, position: 0, duration: 0,
  volume: config.playback.defaultVolume,
  shuffle: false, repeat: 'none',
};

// ─── Player ──────────────────────────────────────────────────────────────────
const player = new Player({
  volume:      config.playback.defaultVolume,
  displayMode: config.display?.mode || 'video',
  width:       parseInt(process.env.DISPLAY_WIDTH  || config.display?.width  || '1920'),
  height:      parseInt(process.env.DISPLAY_HEIGHT || config.display?.height || '1080'),
});

// Player events → broadcast to all clients
player.on('timeUpdate', (position, duration) => {
  playbackState.position = position;
  playbackState.duration = duration;
  broadcast('timeUpdate', { position, duration });
});

player.on('stateChange', (state) => {
  playbackState.playing  = state.playing;
  playbackState.volume   = state.volume;
  broadcast('playbackState', playbackState);
});

player.on('trackEnd', () => {
  if (playbackState.repeat === 'one' && currentTrack) {
    startPlayback(currentTrack);
    return;
  }
  if (queue.length > 0) {
    advanceQueue();
  } else if (playbackState.repeat === 'all' && currentTrack) {
    startPlayback(currentTrack);
  } else {
    currentTrack = null;
    playbackState.playing  = false;
    playbackState.position = 0;
    playbackState.duration = 0;
    player.stop();
    broadcast('trackChange', { currentTrack, queue, playbackState });
  }
});

player.on('trackError', () => {
  broadcast('notification', { type: 'info', message: 'Playback error — skipping' });
  setTimeout(() => {
    if (queue.length > 0) advanceQueue();
    else {
      currentTrack = null;
      playbackState.playing = false;
      player.stop();
      broadcast('trackChange', { currentTrack, queue, playbackState });
    }
  }, 1500);
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({
    event: 'state',
    data: { queue, currentTrack, playbackState, config: publicConfig() },
  }));
  ws.on('message', raw => {
    try {
      const { action, payload } = JSON.parse(raw);
      handleAction(action, payload || {});
    } catch {}
  });
});

function handleAction(action, p) {
  const map = {
    play:            () => resume(),
    pause:           () => pause(),
    next:            () => skipNext(),
    prev:            () => skipPrev(),
    toggleShuffle,
    cycleRepeat,
    clearQueue,
    setVolume:       () => setVolume(p.volume),
    seek:            () => seek(p.position),
    removeFromQueue: () => removeFromQueue(p.index),
    reorderQueue:    () => reorderQueue(p.from, p.to),
    playNow:         () => playNow(p.track),
    displayMode:     () => {
      const mode = p.mode === 'karaoke' ? 'karaoke' : p.mode === 'visualization' ? 'visualization' : 'video';
      player.setDisplayMode(mode);
      if (!config.display) config.display = {};
      config.display.mode = mode;
      saveConfig(config);
      broadcast('configUpdate', publicConfig());
    },
  };
  map[action]?.();
}

function publicConfig() {
  return {
    youtube: {
      authMethod:  config.youtube.authMethod,
      browser:     config.youtube.browser,
      loggedIn:    config.youtube.loggedIn,
      accountName: config.youtube.accountName,
      lastChecked: config.youtube.lastChecked,
    },
    display: {
      mode:   config.display?.mode || 'video',
      width:  config.display?.width  || 1920,
      height: config.display?.height || 1080,
    },
    playback: config.playback,
  };
}

// ─── Search ───────────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });
  const key = `search:${q}`;
  if (cache.has(key)) return res.json(cache.get(key));

  const args = [
    ...getCookieArgs(config),
    `ytsearch25:${q}`,
    '--flat-playlist', '--dump-single-json', '--no-warnings',
  ];

  const ytdlp = spawn('yt-dlp', args);
  let stdout = '', stderr = '';
  ytdlp.stdout.on('data', d => stdout += d);
  ytdlp.stderr.on('data', d => stderr += d);
  ytdlp.on('error', () => res.status(500).json({ error: 'yt-dlp not found' }));
  ytdlp.on('close', code => {
    if (code !== 0 || !stdout.trim()) return res.status(500).json({ error: 'Search failed' });
    try {
      const raw = JSON.parse(stdout);
      const results = (raw.entries || [])
        .filter(e => e.duration && e.duration >= 30 && e.duration <= 600)
        .slice(0, 10)
        .map(e => ({
          videoId:   e.id,
          title:     e.title,
          artist:    e.uploader || e.channel || 'Unknown',
          duration:  e.duration,
          thumbnail: e.thumbnails?.[e.thumbnails.length - 1]?.url
                     || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
        }));
      cache.set(key, { results });
      res.json({ results });
    } catch { res.status(500).json({ error: 'Parse error' }); }
  });
});

// ─── Lyrics ───────────────────────────────────────────────────────────────────
app.get('/api/lyrics', async (req, res) => {
  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const key = `lyrics:${title}:${artist}`;
  if (cache.has(key)) return res.json(cache.get(key));
  const axios = require('axios');
  try {
    const r = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`)}`, { timeout: 5000 });
    if (r.data?.length) {
      const m = r.data[0];
      const v = { synced: m.syncedLyrics||null, plain: m.plainLyrics||null, hasSynced: !!m.syncedLyrics };
      cache.set(key, v); return res.json(v);
    }
  } catch {}
  try {
    const r = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist||'_')}/${encodeURIComponent(title)}`, { timeout: 5000 });
    if (r.data?.lyrics) { const v={synced:null,plain:r.data.lyrics,hasSynced:false}; cache.set(key,v); return res.json(v); }
  } catch {}
  res.json({ synced: null, plain: null, hasSynced: false });
});

// ─── Queue REST ───────────────────────────────────────────────────────────────
app.get('/api/queue', (req, res) => res.json({ queue, currentTrack, playbackState }));

app.post('/api/queue/add', (req, res) => {
  const t = req.body;
  if (!t?.videoId) return res.status(400).json({ error: 'Invalid' });
  queue.push({ ...t, queueId: Date.now() + Math.random() });
  broadcast('queueUpdate', { queue });

  // Auto-start if nothing is currently playing
  if (!currentTrack && !playbackState.playing) {
    advanceQueue();
  }

  res.json({ success: true, queueLength: queue.length });
});

app.post('/api/queue/playnow', (req, res) => { playNow(req.body); res.json({ success: true }); });
app.delete('/api/queue/:index', (req, res) => { removeFromQueue(parseInt(req.params.index)); res.json({ success: true }); });

// ─── Player status ───────────────────────────────────────────────────────────
app.get('/api/player', (req, res) => res.json(player.getStatus()));

// ─── Settings API ─────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(publicConfig()));

app.patch('/api/settings', (req, res) => {
  for (const key of ['playback', 'display']) {
    if (req.body[key]) config[key] = { ...config[key], ...req.body[key] };
  }
  saveConfig(config);
  broadcast('configUpdate', publicConfig());
  res.json({ success: true, config: publicConfig() });
});

app.get('/api/settings/youtube/browsers', async (req, res) => {
  res.json({ browsers: await detectBrowsers() });
});

app.post('/api/settings/youtube/connect-browser', async (req, res) => {
  const { browser } = req.body;
  if (!browser) return res.status(400).json({ error: 'browser required' });
  res.json({ success: true, message: 'Testing cookies — watch for a notification…' });

  const result = await testBrowserCookies(browser);
  if (result.success) {
    config.youtube = { authMethod: 'browser-cookies', browser, loggedIn: true, accountName: result.accountName, lastChecked: new Date().toISOString() };
    saveConfig(config); cache.flushAll();
    player.setCookieArgs(getCookieArgs(config));
    broadcast('configUpdate', publicConfig());
    broadcast('notification', { type: 'success', message: `Connected as ${result.accountName}` });
  } else {
    broadcast('notification', { type: 'error', message: result.error });
  }
});

app.post('/api/settings/youtube/upload-cookies', upload.single('cookies'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  fs.renameSync(req.file.path, COOKIES_PATH);

  const result = await testCookieFile();
  if (result.success) {
    config.youtube = { authMethod: 'cookie-file', browser: config.youtube.browser, loggedIn: true, accountName: result.accountName, lastChecked: new Date().toISOString() };
    saveConfig(config); cache.flushAll();
    player.setCookieArgs(getCookieArgs(config));
    broadcast('configUpdate', publicConfig());
    res.json({ success: true, accountName: result.accountName });
  } else {
    try { fs.unlinkSync(COOKIES_PATH); } catch {}
    res.status(400).json({ success: false, error: result.error });
  }
});

app.post('/api/settings/youtube/disconnect', (req, res) => {
  config.youtube = { authMethod: 'none', browser: 'chrome', loggedIn: false, accountName: '', lastChecked: null };
  saveConfig(config);
  try { fs.unlinkSync(COOKIES_PATH); } catch {}
  cache.flushAll();
  player.setCookieArgs([]);
  broadcast('configUpdate', publicConfig());
  res.json({ success: true });
});

app.post('/api/settings/youtube/test', async (req, res) => {
  let result;
  if (config.youtube.authMethod === 'browser-cookies') {
    result = await testBrowserCookies(config.youtube.browser);
  } else if (config.youtube.authMethod === 'cookie-file') {
    result = await testCookieFile();
  } else if (config.youtube.authMethod === 'oauth2') {
    result = await testOAuth2();
  } else {
    return res.json({ success: false, error: 'No auth method configured' });
  }

  config.youtube.loggedIn    = result.success;
  config.youtube.accountName = result.success ? (result.accountName || config.youtube.accountName || 'YouTube Account') : config.youtube.accountName;
  config.youtube.lastChecked = new Date().toISOString();
  saveConfig(config);
  broadcast('configUpdate', publicConfig());
  res.json(result);
});

app.post('/api/settings/youtube/oauth2/start', async (req, res) => {
  try {
    const result = await startOAuth2Flow();
    res.json(result.success ? { success: true, url: result.url, code: result.code } : { success: false, error: result.error });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/settings/youtube/oauth2/status', (req, res) => {
  const state = getOAuthState();
  if (state.status === 'authorized') {
    config.youtube = {
      authMethod: 'oauth2', browser: config.youtube.browser,
      loggedIn: true, accountName: state.accountName || 'YouTube Account',
      lastChecked: new Date().toISOString(),
    };
    saveConfig(config); cache.flushAll();
    player.setCookieArgs(getCookieArgs(config));
    broadcast('configUpdate', publicConfig());
    res.json({ status: 'authorized', accountName: config.youtube.accountName });
  } else if (state.status === 'pending') {
    res.json({ status: 'pending', code: state.code || null, url: state.url || null });
  } else {
    res.json({ status: state.status, error: state.error });
  }
});

app.post('/api/settings/youtube/oauth2/cancel', (req, res) => {
  cancelOAuth2Flow();
  res.json({ success: true });
});

app.get('/api/settings/youtube/liked', async (req, res) => {
  try { res.json({ tracks: await fetchLikedSongs(config) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  exec('yt-dlp --version', (e1, v1) =>
    exec('ffmpeg -version 2>&1 | head -1', (e2, v2) =>
      exec('mpv --version 2>&1 | head -1', (e3, v3) =>
        res.json({
          status: 'ok',
          ytdlp:   e1 ? 'not found' : v1.trim(),
          ffmpeg:  e2 ? 'not found' : v2.trim(),
          mpv:     e3 ? 'not found' : v3.trim(),
          player:  player.getStatus(),
          youtube: { loggedIn: config.youtube.loggedIn, method: config.youtube.authMethod },
        })
      )
    )
  );
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, '../public/remote.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ─── Playback helpers ─────────────────────────────────────────────────────────

function startPlayback(track) {
  if (!track) return;
  currentTrack = track;
  playbackState.playing  = true;
  playbackState.position = 0;

  player.setCookieArgs(getCookieArgs(config));
  player.playTrack(track);

  broadcast('trackChange', { currentTrack, queue, playbackState });
  fetchAndLoadLyrics(track);
}

async function fetchAndLoadLyrics(track) {
  try {
    const axios = require('axios');
    const r = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(`${track.artist} ${track.title}`)}`, { timeout: 5000 });
    if (r.data?.length && r.data[0].syncedLyrics) {
      player.loadLyrics(r.data[0].syncedLyrics);
    }
  } catch {}
}

function advanceQueue() {
  if (playbackState.shuffle && queue.length > 1) {
    currentTrack = queue.splice(Math.floor(Math.random() * queue.length), 1)[0];
  } else if (queue.length > 0) {
    currentTrack = queue.shift();
  } else {
    return;
  }
  startPlayback(currentTrack);
}

function resume()  { player.resume(); playbackState.playing = true;  broadcast('playbackState', playbackState); }
function pause()   { player.pause();  playbackState.playing = false; broadcast('playbackState', playbackState); }

function skipNext() {
  if (queue.length > 0) advanceQueue();
  else {
    currentTrack = null;
    playbackState.playing = false;
    player.stop();
    broadcast('trackChange', { currentTrack, queue, playbackState });
  }
}

function skipPrev() {
  if (currentTrack) startPlayback(currentTrack);
}

function setVolume(v) {
  playbackState.volume = Math.max(0, Math.min(100, v));
  player.setVolume(playbackState.volume);
  broadcast('playbackState', playbackState);
}

function seek(p) {
  playbackState.position = p;
  player.seek(p);
}

function toggleShuffle() {
  playbackState.shuffle = !playbackState.shuffle;
  broadcast('playbackState', playbackState);
}

function cycleRepeat() {
  const m = ['none', 'one', 'all'];
  playbackState.repeat = m[(m.indexOf(playbackState.repeat) + 1) % 3];
  broadcast('playbackState', playbackState);
}

function removeFromQueue(i) {
  if (i >= 0 && i < queue.length) queue.splice(i, 1);
  broadcast('queueUpdate', { queue });
}

function reorderQueue(f, t) {
  if (f >= 0 && t >= 0 && f < queue.length && t < queue.length) {
    const [x] = queue.splice(f, 1);
    queue.splice(t, 0, x);
  }
  broadcast('queueUpdate', { queue });
}

function playNow(track) {
  if (!track) return;
  startPlayback(track);
}

function clearQueue() {
  queue = [];
  broadcast('queueUpdate', { queue });
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
server.listen(PORT, '0.0.0.0', async () => {
  const ip = getLocalIP();
  console.log(`\n🎵  Streamy  →  http://${ip}:${PORT}`);
  console.log(`    Remote:     http://${ip}:${PORT}/remote`);
  if (config.youtube.loggedIn) console.log(`    YouTube:     ✅ Connected as ${config.youtube.accountName}`);
  else                         console.log(`    YouTube:     Not connected — open Settings in the UI`);

  player.setCookieArgs(getCookieArgs(config));
  await player.init(PORT);
});

process.on('SIGTERM', () => { player.destroy(); process.exit(0); });
process.on('SIGINT',  () => { player.destroy(); process.exit(0); });
