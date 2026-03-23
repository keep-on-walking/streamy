/**
 * Streamy — Local Player Manager
 */
'use strict';

const { spawn, exec } = require('child_process');
const EventEmitter     = require('events');
const net              = require('net');
const fs               = require('fs');
const os               = require('os');
const path             = require('path');

function getLocalIP() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch {}
  return '127.0.0.1';
}

function safeText(str = '') {
  return String(str).replace(/['":;\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

const PIPEWIRE_ENV = {
  PIPEWIRE_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`,
  XDG_RUNTIME_DIR:      process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`,
};

function mpvEnv() {
  return { ...process.env, DISPLAY: process.env.DISPLAY || ':0', ...PIPEWIRE_ENV };
}

class Player extends EventEmitter {
  constructor(options = {}) {
    super();
    this.displayMode = options.displayMode || 'video';
    this.width       = options.width       || 1920;
    this.height      = options.height      || 1080;
    this.platform    = options.platform    || 'pc';
    this.maxHeight   = options.maxHeight   || 1080;
    this.mpvVO       = options.mpvVO       || '';
    this.mpvHwdec    = options.mpvHwdec    || 'auto-safe';
    this.mpvExtra    = options.mpvExtraArgs || [];
    this.audioOutput = options.audioOutput || 'auto';

    this.mpvProc      = null;
    this.idleProc     = null;
    this.loadingProc  = null;
    this.ipcSocket    = null;
    this.ipcReady     = false;
    this.ipcBuffer    = '';
    this.currentTrack = null;
    this.cookieArgs   = [];

    this.state = {
      playing:  false,
      position: 0,
      duration: 0,
      volume:   options.volume || 80,
    };

    this.socketPath     = '/tmp/streamy-mpv.sock';
    this.titleFile      = path.join(os.tmpdir(), 'streamy-title.txt');
    this.artistFile     = path.join(os.tmpdir(), 'streamy-artist.txt');
    this.subtitleFile   = path.join(os.tmpdir(), 'streamy-lyrics.srt');
    this.qrImagePath    = path.join(os.tmpdir(), 'streamy-qr.png');
    this.idleImagePath  = path.join(os.tmpdir(), 'streamy-idle.png');
    this.loadingImgPath = path.join(os.tmpdir(), 'streamy-loading.png');

    this.ip   = getLocalIP();
    this.port = 3000;
  }

  async init(port) {
    this.port = port;
    this.ip   = getLocalIP();
    try { fs.unlinkSync(this.socketPath); } catch {}
    await this._generateIdleScreen();
    await this._generateLoadingScreen();
    this._showIdleScreen();

    this._lastPosition  = 0;
    this._stallCount    = 0;
    this._lastSpawnTime = 0;
    const stallThreshold = this.platform === 'pi5' ? 8 : 4;
    setInterval(() => {
      if (!this.state.playing || !this.currentTrack) { this._stallCount = 0; return; }
      if (this.state.position === this._lastPosition) {
        this._stallCount++;
        if (this._stallCount >= stallThreshold) {
          console.warn('[mpv] playback stalled — forcing recovery');
          this._stallCount = 0;
          this.emit('trackError', this.currentTrack);
        }
      } else { this._stallCount = 0; }
      this._lastPosition = this.state.position;
    }, 5000);

    console.log(`\n📺 Local display: mpv on ${this.displayMode} mode`);
    console.log(`   Remote URL:    http://${this.ip}:${this.port}/remote\n`);
  }

  setCookieArgs(args) { this.cookieArgs = args || []; }

  async playTrack(track) {
    if (!track) return;

    const now = Date.now();
    if (now - this._lastSpawnTime < 3000) {
      await new Promise(r => setTimeout(r, 3000 - (now - this._lastSpawnTime)));
    }
    this._lastSpawnTime = Date.now();
    this._stallCount = 0;

    this.currentTrack   = track;
    this.state.playing  = true;
    this.state.position = 0;
    this.state.duration = track.duration || 0;
    this._writeOverlay(track);

    const url = `https://www.youtube.com/watch?v=${track.videoId}`;

    // Seamless transition via IPC loadfile
    if (this.mpvVO !== 'drm' && this.mpvProc && this.mpvProc.exitCode === null && this.ipcReady) {
      this._showLoadingScreen();
      await new Promise(r => setTimeout(r, 300));
      const sent = this._sendIPC('loadfile', url, 'replace');
      if (sent) {
        this._stopIdle();
        setTimeout(() => this._sendIPC('set_property', 'pause', false), 500);
        console.log('[mpv] loadfile →', track.title);
        this.emit('trackStart', track);
        return;
      }
      console.warn('[mpv] loadfile send failed, respawning');
    }

    // Full spawn
    console.log('[mpv] spawning new instance for:', track.title);
    this._showLoadingScreen();
    await new Promise(r => setTimeout(r, 800));
    this._stopIdle();
    this._killMpv();
    try { fs.unlinkSync(this.socketPath); } catch {}

    const args = [
      '--fs', '--no-terminal', '--no-osc', '--no-input-default-bindings',
      `--input-ipc-server=${this.socketPath}`,
      `--volume=${this.state.volume}`,
      '--force-window=yes',
      `--keep-open=${this.mpvVO === 'drm' ? 'no' : 'yes'}`,
      `--hwdec=${this.mpvHwdec}`,
      '--profile=fast',
      ...this.mpvExtra,
    ];

    if (this.mpvVO) args.push(`--vo=${this.mpvVO}`);

    const audioDevice = this._getAudioDevice();
    if (audioDevice) args.push(`--audio-device=${audioDevice}`);

    const ytdlOpts = this._buildYtdlOpts();
    if (ytdlOpts) args.push(`--ytdl-raw-options=${ytdlOpts}`);

    if (this.displayMode === 'visualization' && this.mpvVO !== 'drm') {
      args.push(
        '--ytdl-format=bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
        `--lavfi-complex=[aid1]asplit=2[ao][a1];[a1]showwaves=s=${this.width}x${this.height}:mode=cline:r=30:colors=0x7c5af0@0.85|0x00d4aa@0.5:scale=cbrt,format=yuv420p[vo]`,
      );
    } else if (this.platform === 'pi5') {
      args.push(`--ytdl-format=bestvideo[height<=${this.maxHeight}][vcodec^=avc1]+bestaudio/bestvideo[height<=${this.maxHeight}]+bestaudio/best`);
    } else {
      args.push(`--ytdl-format=bestvideo[height<=${this.maxHeight}][vcodec!=av01]+bestaudio/bestvideo[height<=${this.maxHeight}]+bestaudio/best`);
    }

    args.push(url);
    console.log('[mpv] spawn →', track.title);

    this.mpvProc = spawn('mpv', args, { stdio: ['ignore', 'pipe', 'pipe'], env: mpvEnv() });

    let stderrBuf = '';
    this.mpvProc.stderr.on('data', d => {
      stderrBuf += d.toString();
      if (process.env.DEBUG) console.log('[mpv]', d.toString().trim().slice(0, 200));
    });
    this.mpvProc.stdout.on('data', () => {});

    this.mpvProc.on('exit', (code, signal) => {
      this._disconnectIPC();
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return;
      this.state.playing = false;
      if (this.mpvVO === 'drm' && code === 0) {
        console.log('[mpv] track ended (DRM exit 0)');
        this.emit('trackEnd');
      } else {
        const errTail = stderrBuf.slice(-500).trim();
        if (errTail) console.error('[mpv] stderr:', errTail);
        console.error('[mpv] unexpected exit, code:', code);
        this.emit('trackError', this.currentTrack);
      }
    });

    this.mpvProc.on('error', err => {
      console.error('[mpv] spawn error:', err.message);
      this.emit('trackError', this.currentTrack);
    });

    const ready = await this._waitForSocket(8000);
    if (ready) await this._connectIPC();
    else console.warn('[mpv] IPC socket not ready — playback may still work without control');

    // Hide loading screen once playback starts
    const hideStart = Date.now();
    await new Promise(resolve => {
      const check = () => {
        if (this.state.position > 0 || Date.now() - hideStart > 8000) {
          setTimeout(() => { this._hideLoadingScreen(); resolve(); }, 200);
        } else { setTimeout(check, 200); }
      };
      check();
    });

    this.emit('trackStart', track);
  }

  pause()  { this._sendIPC('set_property', 'pause', true);  this.state.playing = false; this.emit('stateChange', this.state); }
  resume() {
    if (!this.currentTrack) return;
    if (!this._sendIPC('set_property', 'pause', false)) {
      console.warn('[mpv] resume failed, respawning');
      this.ipcReady = false;
      this.playTrack(this.currentTrack);
      return;
    }
    this.state.playing = true;
    this.emit('stateChange', this.state);
  }
  togglePlay() { if (this.state.playing) this.pause(); else this.resume(); }
  seek(position) { this._sendIPC('set_property', 'time-pos', position); this.state.position = position; }
  setVolume(vol) {
    this.state.volume = Math.max(0, Math.min(100, vol));
    this._sendIPC('set_property', 'volume', this.state.volume);
    this.emit('stateChange', this.state);
  }
  setDisplayMode(mode) {
    const old = this.displayMode;
    this.displayMode = mode === 'karaoke' ? 'karaoke' : mode === 'visualization' ? 'visualization' : 'video';
    if (this.displayMode !== old && this.currentTrack) this.playTrack(this.currentTrack);
  }

  loadLyrics(syncedLrc) {
    if (!syncedLrc || !this.ipcReady) return;
    try {
      const srt = this._lrcToSrt(syncedLrc);
      fs.writeFileSync(this.subtitleFile, srt);
      this._sendIPC('sub-add', this.subtitleFile);
      this._sendIPC('set_property', 'sub-font-size', 52);
      this._sendIPC('set_property', 'sub-color', '#FFFFFF');
      this._sendIPC('set_property', 'sub-shadow-offset', 3);
      this._sendIPC('set_property', 'sub-shadow-color', '#000000AA');
    } catch (e) { console.warn('[mpv] subtitle load error:', e.message); }
  }

  removeSubs() { this._sendIPC('sub-remove'); }

  stop() {
    this._showLoadingScreen();
    this._killMpv();
    this.currentTrack   = null;
    this.state.playing  = false;
    this.state.position = 0;
    this.state.duration = 0;
    this._showIdleScreen();
    setTimeout(() => this._hideLoadingScreen(), 1500);
    this.emit('stateChange', this.state);
  }

  getStatus() {
    return {
      displayMode:  this.displayMode,
      currentTrack: this.currentTrack,
      state:        { ...this.state },
      ip:           this.ip,
      remoteUrl:    `http://${this.ip}:${this.port}/remote`,
    };
  }

  destroy() { this._killMpv(); this._stopIdle(); this._disconnectIPC(); }

  // ── IPC ───────────────────────────────────────────────────────────────────────

  _buildYtdlOpts() {
    if (!this.cookieArgs.length) return '';
    const opts = [];
    for (let i = 0; i < this.cookieArgs.length; i++) {
      const arg = this.cookieArgs[i].replace(/^--/, '');
      if (i + 1 < this.cookieArgs.length && !this.cookieArgs[i + 1].startsWith('--')) {
        opts.push(`${arg}=${this.cookieArgs[i + 1]}`); i++;
      } else { opts.push(arg); }
    }
    return opts.join(',');
  }

  _waitForSocket(timeout = 5000) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        if (fs.existsSync(this.socketPath)) return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(check, 150);
      };
      check();
    });
  }

  _connectIPC() {
    return new Promise(resolve => {
      try {
        this.ipcSocket = net.createConnection(this.socketPath);
        this.ipcBuffer = '';
        this.ipcSocket.on('connect', () => {
          this.ipcReady = true;
          this._sendIPC('observe_property', 1, 'time-pos');
          this._sendIPC('observe_property', 2, 'duration');
          this._sendIPC('observe_property', 3, 'pause');
          this._sendIPC('observe_property', 4, 'eof-reached');
          resolve();
        });
        this.ipcSocket.on('data', data => {
          this.ipcBuffer += data.toString();
          const lines = this.ipcBuffer.split('\n');
          this.ipcBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try { this._handleIPCMessage(JSON.parse(line)); } catch {}
          }
        });
        this.ipcSocket.on('error', () => { this.ipcReady = false; resolve(); });
        this.ipcSocket.on('close', () => { this.ipcReady = false; });
        setTimeout(() => { if (!this.ipcReady) resolve(); }, 3000);
      } catch { resolve(); }
    });
  }

  _handleIPCMessage(msg) {
    if (msg.event === 'property-change') {
      if (msg.name === 'time-pos' && typeof msg.data === 'number') {
        this.state.position = msg.data;
        this.emit('timeUpdate', this.state.position, this.state.duration);
      } else if (msg.name === 'duration' && typeof msg.data === 'number') {
        this.state.duration = msg.data;
      } else if (msg.name === 'pause' && typeof msg.data === 'boolean') {
        this.state.playing = !msg.data;
        this.emit('stateChange', this.state);
      } else if (msg.name === 'eof-reached' && msg.data === true) {
        console.log('[mpv] eof-reached — track finished');
        this.emit('trackEnd');
      }
    } else if (msg.event === 'end-file') {
      console.log('[mpv] end-file reason:', msg.reason);
      if (msg.reason === 'eof' || msg.reason === 'error') this._showLoadingScreen();
      if (msg.reason === 'eof') this.emit('trackEnd');
      else if (msg.reason === 'error') this.emit('trackError', this.currentTrack);
    }
  }

  _sendIPC(...args) {
    if (!this.ipcSocket || !this.ipcReady) return false;
    try { this.ipcSocket.write(JSON.stringify({ command: args }) + '\n'); return true; } catch { this.ipcReady = false; return false; }
  }

  _disconnectIPC() {
    if (this.ipcSocket) {
      try { this.ipcSocket.destroy(); } catch {}
      this.ipcSocket = null; this.ipcReady = false;
    }
  }

  _killMpv() {
    this._disconnectIPC();
    if (this.mpvProc) {
      const proc = this.mpvProc; this.mpvProc = null;
      proc.removeAllListeners('exit');
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    }
  }

  // ── Screens ──────────────────────────────────────────────────────────────────

  async _generateIdleScreen() {
    const remoteUrl = `http://${this.ip}:${this.port}/remote`;
    let hasQR = false;
    try {
      const QRCode = require('qrcode');
      await QRCode.toFile(this.qrImagePath, remoteUrl, { width: 300, margin: 2, color: { dark: '#ffffff', light: '#00000000' } });
      hasQR = true;
    } catch { console.warn('[player] qrcode package not found — run: npm install qrcode'); }

    const w = this.width, h = this.height;
    const qrArg = hasQR ? this.qrImagePath : '';
    const pyScript = `
import sys
from PIL import Image, ImageDraw, ImageFont
import os
w, h = ${w}, ${h}
img = Image.new('RGB', (w, h), color=(13, 13, 20))
draw = ImageDraw.Draw(img)
def load_font(size, bold=False):
    candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/liberation/LiberationSans.ttf',
    ]
    for c in candidates:
        if os.path.exists(c): return ImageFont.truetype(c, size)
    return ImageFont.load_default()
font_lg = load_font(96, bold=True)
font_sm = load_font(30)
font_url = load_font(22)
font_tip = load_font(24)
txt_streamy = 'streamy'
bb = draw.textbbox((0,0), txt_streamy, font=font_lg)
tw = bb[2] - bb[0]
if '${qrArg}':
    logo_y = 80
    wordmark_x = (w - tw) // 2
    draw.text((wordmark_x, logo_y), txt_streamy, font=font_lg, fill=(240, 238, 255))
    jukebox_y = logo_y + 115
    tri_size = 22; tri_x = wordmark_x; tri_cy = jukebox_y + 15
    tri = [(tri_x, tri_cy - tri_size//2), (tri_x, tri_cy + tri_size//2), (tri_x + int(tri_size*0.85), tri_cy)]
    draw.polygon(tri, fill=(127, 119, 221))
    draw.text((tri_x + tri_size + 6, jukebox_y), 'JUKEBOX', font=font_sm, fill=(139, 130, 204))
    try:
        qr = Image.open('${qrArg}').convert('RGBA')
        qr = qr.resize((280, 280), Image.NEAREST)
        img.paste(qr, ((w-280)//2, (h-280)//2+30), qr)
    except Exception as e: print('QR paste error:', e, file=sys.stderr)
    scan_txt = 'Scan to add music'
    bb2 = draw.textbbox((0,0), scan_txt, font=font_tip)
    draw.text(((w-(bb2[2]-bb2[0]))//2, h-130), scan_txt, font=font_tip, fill=(255,255,255,178))
    bb3 = draw.textbbox((0,0), '${remoteUrl}', font=font_url)
    draw.text(((w-(bb3[2]-bb3[0]))//2, h-90), '${remoteUrl}', font=font_url, fill=(255,255,255,89))
else:
    logo_y = h//2 - 100; wordmark_x = (w - tw) // 2
    draw.text((wordmark_x, logo_y), txt_streamy, font=font_lg, fill=(240, 238, 255))
    jukebox_y = logo_y + 115
    tri_size = 22; tri_x = wordmark_x; tri_cy = jukebox_y + 15
    tri = [(tri_x, tri_cy - tri_size//2), (tri_x, tri_cy + tri_size//2), (tri_x + int(tri_size*0.85), tri_cy)]
    draw.polygon(tri, fill=(127, 119, 221))
    draw.text((tri_x + tri_size + 6, jukebox_y), 'JUKEBOX', font=font_sm, fill=(139, 130, 204))
    bb2 = draw.textbbox((0,0), '${remoteUrl}', font=font_url)
    draw.text(((w-(bb2[2]-bb2[0]))//2, logo_y+180), '${remoteUrl}', font=font_url, fill=(255,255,255,153))
img.save('${this.idleImagePath}')
print('ok')
`;
    try {
      await new Promise((resolve, reject) => {
        const proc = require('child_process').spawn('python3', ['-c', pyScript]);
        let err = '';
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
      });
    } catch (e) {
      console.warn('[player] Idle screen (Python) failed:', e.message);
      try { await this._run(`ffmpeg -y -f lavfi -i "color=c=0x0a0a14:s=${w}x${h}:d=1" -vf "drawtext=text='streamy':fontsize=96:fontcolor=0xf0eeff:x=(w-tw)/2:y=(h/2)-80" -frames:v 1 "${this.idleImagePath}"`); } catch {}
    }
  }

  async _generateLoadingScreen() {
    const w = this.width, h = this.height;
    const pyScript = `
import sys
from PIL import Image, ImageDraw, ImageFont
import os
w, h = ${w}, ${h}
img = Image.new('RGB', (w, h), color=(13, 13, 20))
draw = ImageDraw.Draw(img)
def load_font(size, bold=False):
    candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/liberation/LiberationSans.ttf',
    ]
    for c in candidates:
        if os.path.exists(c): return ImageFont.truetype(c, size)
    return ImageFont.load_default()
font_lg = load_font(96, bold=True)
font_sm = load_font(30)
font_tip = load_font(24)
txt = 'streamy'
bb = draw.textbbox((0,0), txt, font=font_lg)
tw = bb[2] - bb[0]
logo_y = h//2 - 100; wordmark_x = (w - tw) // 2
draw.text((wordmark_x, logo_y), txt, font=font_lg, fill=(240, 238, 255))
jukebox_y = logo_y + 115
tri_size = 22; tri_x = wordmark_x; tri_cy = jukebox_y + 15
tri = [(tri_x, tri_cy - tri_size//2), (tri_x, tri_cy + tri_size//2), (tri_x + int(tri_size*0.85), tri_cy)]
draw.polygon(tri, fill=(127, 119, 221))
draw.text((tri_x + tri_size + 6, jukebox_y), 'JUKEBOX', font=font_sm, fill=(139, 130, 204))
loading_txt = 'Loading...'
bb2 = draw.textbbox((0,0), loading_txt, font=font_tip)
draw.text(((w-(bb2[2]-bb2[0]))//2, logo_y+190), loading_txt, font=font_tip, fill=(255,255,255,100))
img.save('${this.loadingImgPath}')
print('ok')
`;
    try {
      await new Promise((resolve, reject) => {
        const proc = require('child_process').spawn('python3', ['-c', pyScript]);
        let err = '';
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
      });
    } catch (e) {
      console.warn('[player] Loading screen (Python) failed:', e.message);
      try { await this._run(`ffmpeg -y -f lavfi -i "color=c=0x0a0a14:s=${w}x${h}:d=1" -vf "drawtext=text='streamy':fontsize=96:fontcolor=0xf0eeff:x=(w-tw)/2:y=(h/2)-80" -frames:v 1 "${this.loadingImgPath}"`); } catch {}
    }
  }

  _showIdleScreen() {
    this._stopIdle();
    if (!fs.existsSync(this.idleImagePath)) return;
    this.idleProc = spawn('mpv', [
      '--fs', '--no-terminal', '--no-osc', '--no-input-default-bindings',
      '--image-display-duration=inf', '--force-window=yes', '--ao=null',
      ...(this.mpvVO ? [`--vo=${this.mpvVO}`] : []),
      this.idleImagePath,
    ], { stdio: 'ignore', env: mpvEnv() });
    this.idleProc.on('error', () => {});
    this.idleProc.on('exit', () => { this.idleProc = null; });
  }

  _stopIdle() {
    if (this.idleProc) { try { this.idleProc.kill('SIGTERM'); } catch {} this.idleProc = null; }
  }

  _showLoadingScreen() {
    this._hideLoadingScreen();
    if (!fs.existsSync(this.loadingImgPath)) return;
    this.loadingProc = spawn('mpv', [
      '--fs', '--no-terminal', '--no-osc', '--no-input-default-bindings',
      '--image-display-duration=inf', '--force-window=yes', '--ao=null', '--ontop',
      this.loadingImgPath,
    ], { stdio: 'ignore', env: mpvEnv() });
    this.loadingProc.on('error', () => { this.loadingProc = null; });
    this.loadingProc.on('exit', () => { this.loadingProc = null; });
  }

  _hideLoadingScreen() {
    if (this.loadingProc) { try { this.loadingProc.kill('SIGTERM'); } catch {} this.loadingProc = null; }
  }

  // ── Audio ─────────────────────────────────────────────────────────────────────

  _getAudioDevice() {
    if (this.audioOutput === 'auto' || !this.audioOutput) return null;
    if (this.audioOutput === 'hdmi') {
      try {
        const { execSync } = require('child_process');
        const devices = execSync('mpv --audio-device=help 2>&1', { encoding: 'utf8', timeout: 5000 });
        const hdmi = devices.match(/\s+(alsa\/\S*hdmi\S*)/i);
        if (hdmi) return hdmi[1];
      } catch {}
      return 'alsa/hdmi:CARD=vc4hdmi0,DEV=0';
    }
    if (this.audioOutput === 'headphone') {
      try {
        const { execSync } = require('child_process');
        const devices = execSync('mpv --audio-device=help 2>&1', { encoding: 'utf8', timeout: 5000 });
        const hp = devices.match(/\s+'(alsa\/\S*(?:[Hh]eadphone|analog)\S*)'/);
        if (hp) return hp[1];
        const pw = devices.match(/\s+'((?:pipewire|pulse)\/\S*analog\S*)'/);
        if (pw) return pw[1];
      } catch {}
      return 'alsa/default:CARD=PCH';
    }
    return null;
  }

  listAudioOutputs() {
    const outputs = [{ id: 'auto', name: 'Auto (system default)', active: this.audioOutput === 'auto' }];
    try {
      const { execSync } = require('child_process');
      const raw = execSync('mpv --audio-device=help 2>&1', { encoding: 'utf8', timeout: 5000 });
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s+'(alsa\/\S+)'\s*\((.+)\)/);
        if (!m) continue;
        const [, device, desc] = m;
        if (/hdmi/i.test(device) && !outputs.find(o => o.id === 'hdmi'))
          outputs.push({ id: 'hdmi', name: `HDMI (${desc.trim()})`, active: this.audioOutput === 'hdmi' });
        else if ((/headphone/i.test(device) || /analog/i.test(desc)) && !outputs.find(o => o.id === 'headphone'))
          outputs.push({ id: 'headphone', name: `Analog / Headphone (${desc.trim()})`, active: this.audioOutput === 'headphone' });
      }
    } catch {}
    return outputs;
  }

  setAudioOutput(output) {
    this.audioOutput = output || 'auto';
    const device = this._getAudioDevice();
    if (this.ipcReady && device) this._sendIPC('set_property', 'audio-device', device);
    if (this.currentTrack && this.state.playing) this.playTrack(this.currentTrack);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  _writeOverlay(track) {
    try {
      fs.writeFileSync(this.titleFile,  safeText(track?.title  || 'Streamy'));
      fs.writeFileSync(this.artistFile, safeText(track?.artist || ''));
    } catch {}
  }

  _lrcToSrt(lrc) {
    const lines = lrc.split('\n').map(l => {
      const m = l.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
      if (!m) return null;
      const ms = parseInt(m[3].padEnd(3, '0'));
      return { time: parseInt(m[1]) * 60 + parseInt(m[2]) + ms / 1000, text: m[4].trim() };
    }).filter(Boolean).filter(l => l.text.length > 0);
    if (!lines.length) return '';
    let srt = '';
    for (let i = 0; i < lines.length; i++) {
      const start = lines[i].time;
      const end = i + 1 < lines.length ? lines[i + 1].time : start + 5;
      srt += `${i + 1}\n${this._fmtSRT(start)} --> ${this._fmtSRT(end)}\n${lines[i].text}\n\n`;
    }
    return srt;
  }

  _fmtSRT(secs) {
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60), ms = Math.floor((secs % 1) * 1000);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
  }

  _run(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 30000 }, err => err ? reject(err) : resolve());
    });
  }
}

module.exports = { Player, getLocalIP };
