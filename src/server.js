/**
 * Streamy — Backend Server v2.1
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

const { RTSPManager, getLocalIP } = require('./rtsp');
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
  playing: false, position: 0,
  volume: config.playback.defaultVolume,
  shuffle: false, repeat: 'none',
};

// ─── RTSP ─────────────────────────────────────────────────────────────────────
const rtsp = new RTSPManager({
  rtspPort: parseInt(process.env.RTSP_PORT   || config.rtsp.port   || '8554'),
  width:    parseInt(process.env.RTSP_WIDTH  || config.rtsp.width  || '1280'),
  height:   parseInt(process.env.RTSP_HEIGHT || config.rtsp.height || '720'),
  bitrate:  process.env.RTSP_BITRATE         || config.rtsp.bitrate || '2M',
});
const RTSP_ENABLED = process.env.RTSP_ENABLED !== 'false' && config.rtsp.enabled;
if (RTSP_ENABLED) {
  rtsp.init().catch(err => console.warn('[RTSP] Could not start:', err.message));
  rtsp.on('streamStart', ({ mode, track }) => broadcast('rtspStatus', { ...rtsp.getStatus(), mode, track }));
  rtsp.on('streamStop',  ()               => broadcast('rtspStatus', rtsp.getStatus()));
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ event: 'state', data: { queue, currentTrack, playbackState, rtsp: rtsp.getStatus(), config: publicConfig() } }));
  ws.on('message', raw => { try { const { action, payload } = JSON.parse(raw); handleAction(action, payload || {}); } catch {} });
});

function handleAction(action, p) {
  const map = {
    play, pause, next, prev, toggleShuffle, cycleRepeat, clearQueue,
    setVolume:       () => setVolume(p.volume),
    seek:            () => seek(p.position),
    removeFromQueue: () => removeFromQueue(p.index),
    reorderQueue:    () => reorderQueue(p.from, p.to),
    playNow:         () => playNow(p.track),
    // Update the karaoke lyric line on the RTSP stream
    lyricLine:       () => RTSP_ENABLED && rtsp.updateLyricLine(p.line || ''),
    // Switch RTSP display mode
    rtspDisplayMode: () => {
      if (!RTSP_ENABLED) return;
      config.rtsp.displayMode = p.mode === 'karaoke' ? 'karaoke' : 'video';
      saveConfig(config);
      rtsp.setDisplayMode(config.rtsp.displayMode);
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
    rtsp:     { ...config.rtsp, displayMode: config.rtsp.displayMode || 'video' },
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
    `ytsearch10:${q}`,
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
      const results = (raw.entries || []).map(e => ({
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

// ─── Audio Stream ─────────────────────────────────────────────────────────────
app.get('/api/stream/:videoId', (req, res) => {
  const videoId = req.params.videoId;

  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ytdlp = spawn('yt-dlp', [
    ...getCookieArgs(config),
    '--no-playlist', '--no-warnings',
    '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
    '-o', '-',
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on('data', d => {
    const msg = d.toString();
    if (msg.includes('ERROR')) console.error('[yt-dlp stream]', msg.trim());
  });
  req.on('close', () => ytdlp.kill());
  ytdlp.on('error', () => { if (!res.headersSent) res.status(500).end(); });
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
app.get('/api/queue',           (req, res) => res.json({ queue, currentTrack, playbackState }));
app.post('/api/queue/add',      (req, res) => {
  const t = req.body;
  if (!t?.videoId) return res.status(400).json({ error: 'Invalid' });
  queue.push({ ...t, queueId: Date.now() + Math.random() });
  broadcast('queueUpdate', { queue });
  res.json({ success: true });
});
app.post('/api/queue/playnow',  (req, res) => { playNow(req.body); res.json({ success: true }); });
app.delete('/api/queue/:index', (req, res) => { removeFromQueue(parseInt(req.params.index)); res.json({ success: true }); });

// ─── RTSP API ─────────────────────────────────────────────────────────────────
app.get('/api/rtsp', (req, res) => res.json(rtsp.getStatus()));

// ─── Settings API ─────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(publicConfig()));

app.patch('/api/settings', (req, res) => {
  for (const key of ['playback', 'rtsp']) {
    if (req.body[key]) config[key] = { ...config[key], ...req.body[key] };
  }
  saveConfig(config);
  broadcast('configUpdate', publicConfig());
  res.json({ success: true, config: publicConfig() });
});

// List detected browsers
app.get('/api/settings/youtube/browsers', async (req, res) => {
  res.json({ browsers: await detectBrowsers() });
});

// Connect via browser cookie extraction (async result via WebSocket)
app.post('/api/settings/youtube/connect-browser', async (req, res) => {
  const { browser } = req.body;
  if (!browser) return res.status(400).json({ error: 'browser required' });
  res.json({ success: true, message: 'Testing cookies — watch for a notification…' });

  const result = await testBrowserCookies(browser);
  if (result.success) {
    config.youtube = { authMethod: 'browser-cookies', browser, loggedIn: true, accountName: result.accountName, lastChecked: new Date().toISOString() };
    saveConfig(config); cache.flushAll();
    broadcast('configUpdate', publicConfig());
    broadcast('notification', { type: 'success', message: `✅ Connected as ${result.accountName}` });
  } else {
    broadcast('notification', { type: 'error', message: result.error });
  }
});

// Upload cookies.txt (Netscape format)
app.post('/api/settings/youtube/upload-cookies', upload.single('cookies'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  fs.renameSync(req.file.path, COOKIES_PATH);

  const result = await testCookieFile();
  if (result.success) {
    config.youtube = { authMethod: 'cookie-file', browser: config.youtube.browser, loggedIn: true, accountName: result.accountName, lastChecked: new Date().toISOString() };
    saveConfig(config); cache.flushAll();
    broadcast('configUpdate', publicConfig());
    res.json({ success: true, accountName: result.accountName });
  } else {
    try { fs.unlinkSync(COOKIES_PATH); } catch {}
    res.status(400).json({ success: false, error: result.error });
  }
});

// Disconnect account
app.post('/api/settings/youtube/disconnect', (req, res) => {
  config.youtube = { authMethod: 'none', browser: 'chrome', loggedIn: false, accountName: '', lastChecked: null };
  saveConfig(config);
  try { fs.unlinkSync(COOKIES_PATH); } catch {}
  cache.flushAll();
  broadcast('configUpdate', publicConfig());
  res.json({ success: true });
});

// Re-test current auth
app.post('/api/settings/youtube/test', async (req, res) => {
  let result;
  if (config.youtube.authMethod === 'browser-cookies') {
    result = await testBrowserCookies(config.youtube.browser);
  } else if (config.youtube.authMethod === 'cookie-file') {
    result = await testCookieFile();
  } else if (config.youtube.authMethod === 'oauth2') {
    // For oauth2, just verify yt-dlp can fetch with the cached token
    result = await testOAuth2();
  } else {
    return res.json({ success: false, error: 'No auth method configured — connect a YouTube account first' });
  }

  config.youtube.loggedIn    = result.success;
  config.youtube.accountName = result.success ? (result.accountName || config.youtube.accountName) : config.youtube.accountName;
  config.youtube.lastChecked = new Date().toISOString();
  saveConfig(config);
  broadcast('configUpdate', publicConfig());
  res.json(result);
});

// OAuth2 device-code flow
app.post('/api/settings/youtube/oauth2/start', async (req, res) => {
  try {
    const result = await startOAuth2Flow();
    if (result.success) {
      res.json({ success: true, url: result.url, code: result.code });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/settings/youtube/oauth2/status', (req, res) => {
  const state = getOAuthState();
  if (state.status === 'authorized') {
    config.youtube = {
      authMethod:  'oauth2',
      browser:     config.youtube.browser,
      loggedIn:    true,
      accountName: state.accountName || 'YouTube Account',
      lastChecked: new Date().toISOString(),
    };
    saveConfig(config);
    cache.flushAll();
    broadcast('configUpdate', publicConfig());
    res.json({ status: 'authorized', accountName: config.youtube.accountName });
  } else if (state.status === 'pending') {
    // Include code+url so client can show them as soon as they're available
    res.json({ status: 'pending', code: state.code || null, url: state.url || null });
  } else {
    res.json({ status: state.status, error: state.error });
  }
});

app.post('/api/settings/youtube/oauth2/cancel', (req, res) => {
  cancelOAuth2Flow();
  res.json({ success: true });
});

// Fetch liked songs from YouTube Music
app.get('/api/settings/youtube/liked', async (req, res) => {
  try { res.json({ tracks: await fetchLikedSongs(config) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  exec('yt-dlp --version', (e1, v1) =>
    exec('ffmpeg -version 2>&1 | head -1', (e2, v2) =>
      res.json({ status: 'ok', ytdlp: e1?'not found':v1.trim(), ffmpeg: e2?'not found':v2.trim(), rtsp: rtsp.getStatus(), youtube: { loggedIn: config.youtube.loggedIn, method: config.youtube.authMethod } })
    )
  );
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ─── Playback helpers ─────────────────────────────────────────────────────────
function play()  { playbackState.playing = true;  broadcast('playbackState', playbackState); }
function pause() { playbackState.playing = false; broadcast('playbackState', playbackState); }
function next()  {
  if (playbackState.shuffle && queue.length > 1) currentTrack = queue.splice(Math.floor(Math.random() * queue.length), 1)[0];
  else if (queue.length > 0) currentTrack = queue.shift();
  else { currentTrack = null; playbackState.playing = false; if (RTSP_ENABLED) rtsp.stopStream(); }
  if (currentTrack && RTSP_ENABLED) rtsp.streamTrack(currentTrack);
  broadcast('trackChange', { currentTrack, queue, playbackState });
}
function prev()          { broadcast('trackChange', { currentTrack, queue, playbackState }); }
function setVolume(v)    { playbackState.volume = Math.max(0, Math.min(100, v)); broadcast('playbackState', playbackState); }
function seek(p)         { playbackState.position = p; broadcast('playbackState', playbackState); }
function toggleShuffle() { playbackState.shuffle = !playbackState.shuffle; broadcast('playbackState', playbackState); }
function cycleRepeat()   { const m=['none','one','all']; playbackState.repeat=m[(m.indexOf(playbackState.repeat)+1)%3]; broadcast('playbackState',playbackState); }
function removeFromQueue(i) { if (i>=0&&i<queue.length) queue.splice(i,1); broadcast('queueUpdate',{queue}); }
function reorderQueue(f,t)  { if(f>=0&&t>=0&&f<queue.length&&t<queue.length){const[x]=queue.splice(f,1);queue.splice(t,0,x);} broadcast('queueUpdate',{queue}); }
function playNow(track)     { if (!track) return; currentTrack=track; playbackState.playing=true; if(RTSP_ENABLED)rtsp.streamTrack(track); broadcast('trackChange',{currentTrack,queue,playbackState}); }
function clearQueue()       { queue=[]; broadcast('queueUpdate',{queue}); }

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n🎵  Streamy  →  http://${ip}:${PORT}`);
  if (config.youtube.loggedIn) console.log(`    YouTube:     ✅ Connected as ${config.youtube.accountName}`);
  else                         console.log(`    YouTube:     Not connected — open Settings in the UI`);
  console.log('');
});

process.on('SIGTERM', () => { rtsp.destroy(); process.exit(0); });
process.on('SIGINT',  () => { rtsp.destroy(); process.exit(0); });
