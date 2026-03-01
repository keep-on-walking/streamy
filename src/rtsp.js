/**
 * Streamy — RTSP Stream Manager
 *
 * Streams music videos (or a colour visualisation fallback) via RTSP using:
 *   • mediamtx   — lightweight RTSP server (single binary, auto-downloaded)
 *   • yt-dlp     — fetches YouTube video/audio URLs
 *   • FFmpeg     — transcodes + overlays track info → publishes to mediamtx
 *
 * Clients (e.g. a Raspberry Pi running VLC/mpv) connect to:
 *   rtsp://SERVER_IP:8554/live
 */

'use strict';

const { spawn, exec } = require('child_process');
const EventEmitter    = require('events');
const fs              = require('fs');
const os              = require('os');
const path            = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────
const MEDIAMTX_VERSION = '1.9.1';
const MEDIAMTX_URLS = {
  linux_x64:   `https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz`,
  linux_arm64: `https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_arm64v8.tar.gz`,
  linux_armv7: `https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_armv7.tar.gz`,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function detectArch() {
  const arch = os.arch();
  if (arch === 'x64')   return 'linux_x64';
  if (arch === 'arm64') return 'linux_arm64';
  if (arch === 'arm')   return 'linux_armv7';
  return 'linux_x64';
}

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
  // Strip characters that cause issues in FFmpeg drawtext
  return String(str)
    .replace(/['":\\%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// ─── RTSPManager ──────────────────────────────────────────────────────────────
class RTSPManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rtspPort   = options.rtspPort   || 8554;
    this.apiPort    = options.apiPort    || 9997;
    this.width      = options.width      || 1280;
    this.height     = options.height     || 720;
    this.bitrate    = options.bitrate    || '2M';

    this.mediamtxProc = null;
    this.ffmpegProc   = null;
    this.currentTrack = null;
    this.mode         = 'idle';   // 'idle' | 'video' | 'visualization'
    this.enabled      = false;
    this._restartTimer = null;

    this.binDir       = path.join(__dirname, '../bin');
    this.mediamtxBin  = path.join(this.binDir, 'mediamtx');
    this.configPath   = path.join(os.tmpdir(), 'streamy-mediamtx.yml');
    this.titleFile    = path.join(os.tmpdir(), 'streamy-title.txt');
    this.artistFile   = path.join(os.tmpdir(), 'streamy-artist.txt');
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Download mediamtx if needed, then start it. */
  async init() {
    if (!fs.existsSync(this.binDir)) fs.mkdirSync(this.binDir, { recursive: true });
    await this._ensureMediaMTX();
    await this._startMediaMTX();
    this.enabled = true;
    console.log(`\n📡 RTSP server: rtsp://${getLocalIP()}:${this.rtspPort}/live`);
    console.log(`   Raspberry Pi: mpv rtsp://${getLocalIP()}:${this.rtspPort}/live --fs --no-audio\n`);
  }

  /** Call this whenever a new track starts playing. */
  async streamTrack(track) {
    if (!this.enabled) return;
    this.currentTrack = track;
    clearTimeout(this._restartTimer);
    this._stopFFmpeg();

    // Write overlay text files immediately
    this._writeOverlay(track);

    // Small gap so mediamtx drops the old publisher
    await new Promise(r => setTimeout(r, 600));

    const hasVideo = await this._hasVideo(track.videoId);
    if (hasVideo) {
      await this._startVideoStream(track);
    } else {
      this._startVisualization(track);
    }
  }

  /** Stop the RTSP stream (idle state). */
  stopStream() {
    this.currentTrack = null;
    clearTimeout(this._restartTimer);
    this._stopFFmpeg();
    this.mode = 'idle';
    this._writeOverlay({ title: 'Streamy', artist: 'Nothing playing' });
    this._startIdleVisualization();
    this.emit('streamStop');
  }

  /** Shut everything down. */
  destroy() {
    clearTimeout(this._restartTimer);
    this._stopFFmpeg();
    if (this.mediamtxProc) { this.mediamtxProc.kill(); this.mediamtxProc = null; }
    this.enabled = false;
  }

  getStatus() {
    const ip = getLocalIP();
    return {
      enabled:  this.enabled,
      mode:     this.mode,
      rtspUrl:  `rtsp://${ip}:${this.rtspPort}/live`,
      hlsUrl:   null, // future
      ip,
    };
  }

  // ── mediamtx ────────────────────────────────────────────────────────────────

  async _ensureMediaMTX() {
    // Use system binary if available
    const inPath = await this._commandExists('mediamtx');
    if (inPath) { this.mediamtxBin = 'mediamtx'; return; }
    if (fs.existsSync(this.mediamtxBin)) return;

    console.log('⏬  Downloading mediamtx RTSP server…');
    const url = MEDIAMTX_URLS[detectArch()];
    const tarPath = path.join(this.binDir, 'mediamtx.tar.gz');

    await this._run(`curl -fsSL "${url}" -o "${tarPath}"`);
    await this._run(`tar -xzf "${tarPath}" -C "${this.binDir}" mediamtx`);
    await this._run(`chmod +x "${this.mediamtxBin}"`);
    fs.unlinkSync(tarPath);
    console.log('✅  mediamtx ready');
  }

  async _startMediaMTX() {
    // Write config
    const config = `
logLevel: error
logDestinations: [stdout]
rtsp:
  enabled: yes
  listenIP: 0.0.0.0
  port: ${this.rtspPort}
  protocols: [tcp, udp]
api:
  enabled: no
paths:
  live:
    source: publisher
    sourceProtocol: automatic
`;
    fs.writeFileSync(this.configPath, config.trim());

    return new Promise((resolve) => {
      this.mediamtxProc = spawn(this.mediamtxBin, [this.configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const ready = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(ready, 3000); // resolve after 3 s regardless

      this.mediamtxProc.stdout.on('data', d => {
        if (d.toString().includes('listener opened')) ready();
      });
      this.mediamtxProc.stderr.on('data', () => {});
      this.mediamtxProc.on('error', err => {
        console.error('[mediamtx] error:', err.message);
        this.enabled = false;
        resolve();
      });
      this.mediamtxProc.on('exit', code => {
        if (code !== 0 && this.enabled) {
          console.error(`[mediamtx] exited with code ${code}`);
        }
        this.mediamtxProc = null;
      });
    });
  }

  // ── Video streaming ──────────────────────────────────────────────────────────

  _hasVideo(videoId) {
    return new Promise(resolve => {
      exec(
        `yt-dlp --no-warnings -f 'bestvideo[height<=720]' --get-format "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
        { timeout: 8000 },
        (err, stdout) => resolve(!err && stdout.trim().length > 0)
      );
    });
  }

  _getVideoUrls(videoId) {
    return new Promise((resolve, reject) => {
      exec(
        `yt-dlp --no-warnings -f 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]' --get-url "https://www.youtube.com/watch?v=${videoId}"`,
        { timeout: 15000 },
        (err, stdout) => {
          if (err) return reject(new Error('yt-dlp URL fetch failed'));
          const urls = stdout.trim().split('\n').filter(Boolean);
          if (!urls.length) return reject(new Error('No URLs returned'));
          resolve(urls);
        }
      );
    });
  }

  async _startVideoStream(track) {
    try {
      const urls = await this._getVideoUrls(track.videoId);
      const hasAudioSeparate = urls.length >= 2;
      const rtspUrl = `rtsp://localhost:${this.rtspPort}/live`;

      const args = ['-loglevel', 'error', '-re'];

      if (hasAudioSeparate) {
        args.push('-i', urls[0], '-i', urls[1]);
      } else {
        args.push('-i', urls[0]);
      }

      args.push(
        // Map video and audio
        '-map', '0:v:0',
        '-map', `${hasAudioSeparate ? '1' : '0'}:a:0`,
        // Video encode
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', this.bitrate,
        '-maxrate', this.bitrate,
        '-bufsize', `${parseInt(this.bitrate) * 2}M`,
        '-vf', `scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2:black,${this._overlayVF()}`,
        // Audio encode
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        // RTSP output
        '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl
      );

      this._launchFFmpeg(args, track, /* restartAsViz= */ true);
      this.mode = 'video';
      this.emit('streamStart', { mode: 'video', track });
      console.log(`[RTSP] 🎬 Streaming video: ${track.title}`);
    } catch (err) {
      console.warn(`[RTSP] Video unavailable (${err.message}), using visualisation`);
      this._startVisualization(track);
    }
  }

  _startVisualization(track) {
    this._writeOverlay(track);
    const rtspUrl = `rtsp://localhost:${this.rtspPort}/live`;

    // Plasma-wave colour visualisation: shifts through RGB using sine waves
    const vizSrc = [
      `nullsrc=size=${this.width}x${this.height}:rate=30`,
      `geq=r='128+127*sin(X/30+t*2)':g='128+127*sin(Y/25+t*1.5+2)':b='128+127*sin((X+Y)/40+t+4)'`,
      'format=yuv420p',
    ].join(',');

    const args = [
      '-loglevel', 'error',
      '-re',
      '-f', 'lavfi', '-i', vizSrc,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-vf', this._overlayVF(),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-b:v', '1500k', '-g', '30',
      '-c:a', 'aac', '-b:a', '64k', '-ar', '44100',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl,
    ];

    this._launchFFmpeg(args, track, /* restartAsViz= */ false);
    this.mode = 'visualization';
    this.emit('streamStart', { mode: 'visualization', track });
    console.log(`[RTSP] 🌈 Visualisation: ${track.title}`);
  }

  _startIdleVisualization() {
    const rtspUrl = `rtsp://localhost:${this.rtspPort}/live`;
    // Slower, darker idle plasma
    const vizSrc = [
      `nullsrc=size=${this.width}x${this.height}:rate=25`,
      `geq=r='60+50*sin(X/60+t)':g='40+60*sin(Y/50+t*0.8+2)':b='80+80*sin((X+Y)/70+t*0.6+4)'`,
      'format=yuv420p',
    ].join(',');

    const args = [
      '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', vizSrc,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-vf', this._overlayVF(),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-b:v', '800k', '-g', '25',
      '-c:a', 'aac', '-b:a', '32k', '-ar', '44100',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl,
    ];

    this._launchFFmpeg(args, null, false);
    this.mode = 'idle';
  }

  // ── FFmpeg helpers ────────────────────────────────────────────────────────────

  _launchFFmpeg(args, track, restartAsViz) {
    this._stopFFmpeg();

    this.ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    this.ffmpegProc.stderr.on('data', d => {
      const msg = d.toString();
      if (/error|Error|fatal/i.test(msg)) {
        process.env.RTSP_DEBUG && console.error('[FFmpeg]', msg.trim().slice(0, 120));
      }
    });

    this.ffmpegProc.on('exit', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return; // intentional stop
      if (!this.enabled) return;

      // If stream died unexpectedly, restart after 2 s
      this._restartTimer = setTimeout(() => {
        if (!this.currentTrack) { this._startIdleVisualization(); return; }
        if (restartAsViz) {
          this._startVisualization(this.currentTrack);
        } else {
          // Re-run viz with the same track
          this._startVisualization(this.currentTrack);
        }
      }, 2000);
    });

    this.ffmpegProc.on('error', err => {
      console.error('[FFmpeg] spawn error:', err.message);
    });
  }

  _stopFFmpeg() {
    if (this.ffmpegProc) {
      this.ffmpegProc.removeAllListeners('exit');
      this.ffmpegProc.kill('SIGTERM');
      setTimeout(() => { try { this.ffmpegProc?.kill('SIGKILL'); } catch {} }, 2000);
      this.ffmpegProc = null;
    }
  }

  // ── Overlay ────────────────────────────────────────────────────────────────

  _writeOverlay(track) {
    try {
      fs.writeFileSync(this.titleFile,  safeText(track?.title  || 'Streamy'));
      fs.writeFileSync(this.artistFile, safeText(track?.artist || ''));
    } catch {}
  }

  _overlayVF() {
    const h  = this.height;
    const tf = this.titleFile.replace(/\\/g, '/');
    const af = this.artistFile.replace(/\\/g, '/');
    return [
      // Semi-transparent bar behind text
      `drawbox=x=0:y=${h - 100}:w=iw:h=100:color=black@0.55:t=fill`,
      // Track title
      `drawtext=textfile='${tf}':reload=1:fontsize=38:fontcolor=white:` +
        `x=(w-tw)/2:y=${h - 82}:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
      // Artist name
      `drawtext=textfile='${af}':reload=1:fontsize=26:fontcolor=white@0.78:` +
        `x=(w-tw)/2:y=${h - 44}:shadowcolor=black@0.9:shadowx=1:shadowy=1`,
    ].join(',');
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  _commandExists(cmd) {
    return new Promise(resolve => exec(`command -v ${cmd}`, err => resolve(!err)));
  }

  _run(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 60000 }, err => err ? reject(err) : resolve());
    });
  }
}

module.exports = { RTSPManager, getLocalIP };
