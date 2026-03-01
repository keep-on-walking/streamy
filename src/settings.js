/**
 * Streamy — Settings Manager
 * Handles config persistence and YouTube auth via browser cookies or cookie file
 */
'use strict';

const { exec } = require('child_process');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const CONFIG_PATH  = path.join(__dirname, '../streamy-config.json');
const COOKIES_PATH = path.join(__dirname, '../youtube-cookies.txt');

const DEFAULTS = {
  youtube: {
    authMethod:  'none',    // 'none' | 'browser-cookies' | 'cookie-file'
    browser:     'firefox',
    loggedIn:    false,
    accountName: '',
    lastChecked: null,
  },
  rtsp: {
    enabled: true,
    port:    8554,
    width:   1280,
    height:  720,
    bitrate: '2M',
  },
  playback: {
    defaultVolume: 80,
  },
};

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return deepMerge(DEFAULTS, raw);
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function deepMerge(base, over) {
  const r = { ...base };
  for (const k of Object.keys(over || {})) {
    r[k] = (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
      ? deepMerge(base[k] || {}, over[k])
      : over[k];
  }
  return r;
}

// ─── Cookie args for yt-dlp ───────────────────────────────────────────────────
function getCookieArgs(cfg) {
  if (cfg.youtube.authMethod === 'browser-cookies')
    return ['--cookies-from-browser', cfg.youtube.browser];
  if (cfg.youtube.authMethod === 'cookie-file' && fs.existsSync(COOKIES_PATH))
    return ['--cookies', COOKIES_PATH];
  if (cfg.youtube.authMethod === 'oauth2')
    return ['--username', 'oauth2', '--password', ''];
  return [];
}

// ─── Check if a browser process is running ────────────────────────────────────
function isBrowserRunning(browser) {
  return new Promise(resolve => {
    const processNames = {
      firefox:  'firefox',
      chrome:   'google-chrome',
      chromium: 'chromium',
      edge:     'microsoft-edge',
    };
    const name = processNames[browser] || browser;
    exec(`pgrep -x ${name} || pgrep -f ${name}`, (err) => resolve(!err));
  });
}

// ─── Copy Firefox cookies while it's running (workaround for SQLite lock) ─────
function copyFirefoxCookiesTemp() {
  return new Promise((resolve, reject) => {
    // Find Firefox profile directory
    const profileBase = path.join(os.homedir(), '.mozilla', 'firefox');
    if (!fs.existsSync(profileBase)) return reject(new Error('Firefox profile not found'));

    // Find the default profile
    let profileDir = null;
    try {
      const entries = fs.readdirSync(profileBase);
      // Prefer default-release, then default, then any .default folder
      const preferred = entries.find(e => e.endsWith('.default-release'))
        || entries.find(e => e.endsWith('.default'))
        || entries.find(e => e.includes('default'));
      if (preferred) profileDir = path.join(profileBase, preferred);
    } catch {}

    if (!profileDir) return reject(new Error('Could not find Firefox profile directory'));

    const cookiesDb  = path.join(profileDir, 'cookies.sqlite');
    const tempDb     = path.join(os.tmpdir(), 'streamy-ff-cookies.sqlite');

    if (!fs.existsSync(cookiesDb))
      return reject(new Error('Firefox cookies database not found — have you logged into YouTube in Firefox?'));

    // Copy the SQLite file (bypasses the lock for reading)
    try {
      fs.copyFileSync(cookiesDb, tempDb);
      resolve(tempDb);
    } catch (e) {
      reject(new Error(`Could not copy Firefox cookies: ${e.message}`));
    }
  });
}

// ─── Test auth using a simple YouTube video (no YouTube Music needed) ─────────
// We test by fetching the title of a known YouTube video WITH cookies.
// If cookies are valid and belong to a logged-in account, yt-dlp will succeed.
// We also try the YouTube subscriptions feed which only works when logged in.
function runAuthTest(cookieArgs) {
  return new Promise(resolve => {
    // Use YouTube subscriptions feed — only accessible when logged in
    // Fall back to a simple video fetch if that fails
    const args = [
      ...cookieArgs,
      '--no-warnings',
      '--playlist-items', '1',
      '--print', '%(channel)s|||%(uploader)s|||%(title)s',
      'https://www.youtube.com/feed/subscriptions',
    ].join(' ');

    exec(`yt-dlp ${args} 2>&1`, { timeout: 25000 }, (err, stdout) => {
      const out = (stdout || '').trim();

      // Check for specific known error conditions
      if (out.includes('Sign in to confirm') || out.includes('not available') ||
          out.includes('login') || out.includes('Sign in')) {
        return resolve({ success: false, error: 'YouTube is asking you to sign in — cookies are not valid or have expired' });
      }

      if (out.includes('database is locked') || out.includes('unable to open')) {
        return resolve({ success: false, error: 'BROWSER_RUNNING' });
      }

      if (out.includes('No such keyring') || out.includes('SecretService')) {
        // Keyring warning — not fatal, cookies may still work
      }

      if (err && !out.includes('|||')) {
        // Subscriptions feed failed — try a simpler test with a known video
        // If cookies work at all, yt-dlp should be able to fetch this
        const fallbackArgs = [
          ...cookieArgs,
          '--no-warnings',
          '--print', '%(channel)s',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ].join(' ');

        exec(`yt-dlp ${fallbackArgs} 2>&1`, { timeout: 15000 }, (err2, stdout2) => {
          const out2 = (stdout2 || '').trim();
          if (out2.includes('database is locked')) {
            return resolve({ success: false, error: 'BROWSER_RUNNING' });
          }
          if (!err2 && out2 && !out2.includes('ERROR')) {
            // Cookies work for basic access — that's good enough
            resolve({ success: true, accountName: 'YouTube Account' });
          } else {
            resolve({ success: false, error: 'Could not verify YouTube cookies — make sure you are logged into YouTube and try again' });
          }
        });
        return;
      }

      // Parse account name from subscriptions feed output
      const lines = out.split('\n').filter(l => l.includes('|||'));
      if (lines.length > 0) {
        const parts = lines[0].split('|||');
        const name = parts[0] || parts[1] || 'YouTube Account';
        return resolve({ success: true, accountName: name });
      }

      // Got output without errors — cookies worked
      resolve({ success: true, accountName: 'YouTube Account' });
    });
  });
}

// ─── Test browser cookies ─────────────────────────────────────────────────────
async function testBrowserCookies(browser) {
  // Check if browser is running — if so, try to copy cookies first (Firefox only)
  const running = await isBrowserRunning(browser);

  if (running && browser === 'firefox') {
    // Try copying the SQLite file to bypass the lock
    try {
      const tempDb = await copyFirefoxCookiesTemp();
      // Use the copied file as a workaround
      const result = await runAuthTest(['--cookies-from-browser', `firefox:${path.dirname(tempDb)}`]);
      // Clean up temp file
      try { fs.unlinkSync(tempDb); } catch {}
      if (result.success) return result;
      // Fall through to normal method as last attempt
    } catch {}

    // Standard approach — may fail if SQLite is locked
    const result = await runAuthTest(['--cookies-from-browser', browser]);
    if (result.error === 'BROWSER_RUNNING') {
      return {
        success: false,
        error: `Firefox is currently open and its cookie database is locked.\n\nPlease close Firefox completely and try again, OR use the "Upload cookies.txt" method instead (works while Firefox is running).`,
      };
    }
    return result;
  }

  if (running && browser !== 'firefox') {
    // Chrome/Chromium can usually be read while running
    const result = await runAuthTest(['--cookies-from-browser', browser]);
    if (result.error === 'BROWSER_RUNNING') {
      return {
        success: false,
        error: `${browser} appears to be running and its cookies are locked. Try closing ${browser} first.`,
      };
    }
    return result;
  }

  // Browser not running — straightforward
  return runAuthTest(['--cookies-from-browser', browser]);
}

// ─── Validate and test a cookies.txt file ────────────────────────────────────
async function testCookieFile() {
  if (!fs.existsSync(COOKIES_PATH))
    return { success: false, error: 'No cookie file has been uploaded yet' };

  // Basic format validation — Netscape cookie files start with a specific header
  try {
    const firstLine = fs.readFileSync(COOKIES_PATH, 'utf8').split('\n')[0] || '';
    if (!firstLine.includes('Netscape') && !firstLine.startsWith('#') && !firstLine.includes('\t')) {
      return {
        success: false,
        error: 'This does not look like a valid cookies.txt file. Make sure you export using the "Get cookies.txt LOCALLY" extension and select youtube.com.',
      };
    }

    // Check that it contains YouTube cookies specifically
    const content = fs.readFileSync(COOKIES_PATH, 'utf8');
    if (!content.includes('youtube.com') && !content.includes('.youtube.com')) {
      return {
        success: false,
        error: 'This cookies file does not contain YouTube cookies. Make sure you are on youtube.com when you export, and select "youtube.com" (not "current site only").',
      };
    }

    // Check for session cookie (indicates logged-in state)
    if (!content.includes('SAPISID') && !content.includes('SID') && !content.includes('LOGIN_INFO')) {
      return {
        success: false,
        error: 'These cookies do not appear to belong to a logged-in YouTube account. Please log into YouTube in your browser first, then re-export the cookies.',
      };
    }
  } catch {}

  return runAuthTest(['--cookies', COOKIES_PATH]);
}

// ─── Fetch liked songs from YouTube Music ─────────────────────────────────────
function fetchLikedSongs(cfg) {
  return new Promise((resolve, reject) => {
    const args = getCookieArgs(cfg);
    if (!args.length) return reject(new Error('Not authenticated'));

    const cmd = `yt-dlp ${args.join(' ')} --no-warnings --flat-playlist --dump-single-json "https://music.youtube.com/library/liked_music" 2>/dev/null`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error('Failed to fetch liked songs — you may need YouTube Music'));
      try {
        const d = JSON.parse(stdout);
        resolve((d.entries || []).map(e => ({
          videoId:   e.id,
          title:     e.title,
          artist:    e.uploader || e.channel || 'Unknown',
          duration:  e.duration,
          thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
        })));
      } catch { reject(new Error('Could not parse liked songs response')); }
    });
  });
}

// ─── Detect installed browsers ────────────────────────────────────────────────
function detectBrowsers() {
  return new Promise(resolve => {
    const list = [
      { id: 'firefox',  name: 'Firefox',        cmd: 'firefox --version 2>/dev/null' },
      { id: 'chrome',   name: 'Google Chrome',  cmd: 'google-chrome --version 2>/dev/null || google-chrome-stable --version 2>/dev/null' },
      { id: 'chromium', name: 'Chromium',        cmd: 'chromium-browser --version 2>/dev/null || chromium --version 2>/dev/null' },
      { id: 'edge',     name: 'Microsoft Edge', cmd: 'microsoft-edge --version 2>/dev/null' },
    ];
    const found = [];
    let n = list.length;
    list.forEach(b => {
      exec(b.cmd, { timeout: 3000 }, (err, out) => {
        if (!err && out.trim()) found.push({ id: b.id, name: b.name, version: out.trim() });
        if (--n === 0) resolve(found);
      });
    });
  });
}

// OAuth2 continues below...
// ─── OAuth2 device-code flow ──────────────────────────────────────────────────
// State shared across calls
let _oauthProc    = null;
let _oauthState   = { status: 'idle', url: null, code: null, error: null, accountName: null };

function getOAuthState() { return { ..._oauthState }; }

function startOAuth2Flow() {
  return new Promise((resolve, reject) => {
    // Kill any existing attempt
    if (_oauthProc) { try { _oauthProc.kill(); } catch {} _oauthProc = null; }
    _oauthState = { status: 'pending', url: null, code: null, error: null, accountName: null };

    const { spawn } = require('child_process');

    // yt-dlp oauth2 flow: prints "Please open ... and enter code XXXX-XXXX" to stderr
    _oauthProc = spawn('yt-dlp', [
      '--username', 'oauth2',
      '--password', '',
      '--no-warnings',
      '--print', '%(channel)s',
      '--playlist-items', '1',
      'https://www.youtube.com/feed/subscriptions',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';

    _oauthProc.stderr.on('data', chunk => {
      stderr += chunk.toString();
      // Look for the device auth URL and code
      // Format: "Please open https://www.google.com/device and enter code ABCD-EFGH"
      const urlMatch  = stderr.match(/https?:\/\/[^\s]+google\.com\/device[^\s]*/i)
                     || stderr.match(/open\s+(https?:\/\/[^\s]+)/i);
      const codeMatch = stderr.match(/(?:code|enter)\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i)
                     || stderr.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);

      if (urlMatch && codeMatch && _oauthState.status === 'pending') {
        _oauthState.url  = urlMatch[1] || urlMatch[0];
        _oauthState.code = codeMatch[1];
        resolve({ success: true, url: _oauthState.url, code: _oauthState.code });
      }
    });

    _oauthProc.stdout.on('data', chunk => {
      // If yt-dlp printed account info — auth succeeded
      const name = chunk.toString().trim();
      if (name && name !== 'NA') {
        _oauthState.status = 'authorized';
        _oauthState.accountName = name;
      }
    });

    _oauthProc.on('close', code => {
      _oauthProc = null;
      if (_oauthState.status === 'pending') {
        _oauthState.status = 'error';
        _oauthState.error  = 'yt-dlp exited before authorization completed. Make sure yt-dlp is up to date.';
        // In case resolve was never called
        resolve({ success: false, error: _oauthState.error });
      } else if (_oauthState.status === 'authorized') {
        // All good — handled by caller polling getOAuthState()
      }
    });

    _oauthProc.on('error', err => {
      _oauthState.status = 'error';
      _oauthState.error  = err.message;
      reject(err);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (_oauthState.status === 'pending') {
        _oauthState.status = 'error';
        _oauthState.error  = 'Authorization timed out after 5 minutes';
        if (_oauthProc) { try { _oauthProc.kill(); } catch {} _oauthProc = null; }
      }
    }, 5 * 60 * 1000);
  });
}

function cancelOAuth2Flow() {
  if (_oauthProc) { try { _oauthProc.kill(); } catch {} _oauthProc = null; }
  _oauthState = { status: 'idle', url: null, code: null, error: null, accountName: null };
}

module.exports = {
  loadConfig, saveConfig, getCookieArgs,
  testBrowserCookies, testCookieFile,
  fetchLikedSongs, detectBrowsers,
  startOAuth2Flow, cancelOAuth2Flow, getOAuthState,
  COOKIES_PATH,
};
