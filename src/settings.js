/**
 * Streamy — Settings Manager
 * Handles config persistence, YouTube auth via browser cookies or cookie file upload
 */
'use strict';

const { exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');

const CONFIG_PATH  = path.join(__dirname, '../streamy-config.json');
const COOKIES_PATH = path.join(__dirname, '../youtube-cookies.txt');

const DEFAULTS = {
  youtube: {
    authMethod:  'none',    // 'none' | 'browser-cookies' | 'cookie-file'
    browser:     'chrome',  // 'chrome' | 'chromium' | 'firefox' | 'edge'
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

/** Returns yt-dlp args array for cookie injection */
function getCookieArgs(cfg) {
  if (cfg.youtube.authMethod === 'browser-cookies')
    return ['--cookies-from-browser', cfg.youtube.browser];
  if (cfg.youtube.authMethod === 'cookie-file' && fs.existsSync(COOKIES_PATH))
    return ['--cookies', COOKIES_PATH];
  return [];
}

function testBrowserCookies(browser) {
  return new Promise(resolve => {
    const cmd = `yt-dlp --cookies-from-browser ${browser} --no-warnings --flat-playlist --dump-single-json --playlist-items 1 "https://music.youtube.com/library/liked_music" 2>&1`;
    exec(cmd, { timeout: 20000 }, (err, stdout) => {
      if (err || stdout.includes('ERROR')) {
        const msg = stdout.includes('no such') || stdout.includes('not found')
          ? `Browser "${browser}" not found or has no YouTube cookies. Make sure you are logged into YouTube in ${browser} first.`
          : `Could not read ${browser} cookies. Try logging into YouTube in ${browser} and retrying.`;
        return resolve({ success: false, error: msg });
      }
      try {
        const d = JSON.parse(stdout);
        resolve({ success: true, accountName: d.uploader || d.channel || 'YouTube Account' });
      } catch {
        // yt-dlp ran without error but output wasn't JSON — cookies likely worked
        resolve({ success: true, accountName: 'YouTube Account' });
      }
    });
  });
}

function testCookieFile() {
  return new Promise(resolve => {
    if (!fs.existsSync(COOKIES_PATH))
      return resolve({ success: false, error: 'No cookie file uploaded yet' });
    const cmd = `yt-dlp --cookies "${COOKIES_PATH}" --no-warnings --flat-playlist --dump-single-json --playlist-items 1 "https://music.youtube.com/library/liked_music" 2>&1`;
    exec(cmd, { timeout: 20000 }, (err, stdout) => {
      if (err || stdout.includes('ERROR'))
        return resolve({ success: false, error: 'Cookie file is invalid or expired — please export a fresh one' });
      try {
        const d = JSON.parse(stdout);
        resolve({ success: true, accountName: d.uploader || d.channel || 'YouTube Account' });
      } catch {
        resolve({ success: true, accountName: 'YouTube Account' });
      }
    });
  });
}

function fetchLikedSongs(cfg) {
  return new Promise((resolve, reject) => {
    const args = getCookieArgs(cfg);
    if (!args.length) return reject(new Error('Not authenticated'));
    const cmd = `yt-dlp ${args.join(' ')} --no-warnings --flat-playlist --dump-single-json "https://music.youtube.com/library/liked_music" 2>/dev/null`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error('Failed to fetch liked songs'));
      try {
        const d = JSON.parse(stdout);
        resolve((d.entries || []).map(e => ({
          videoId: e.id, title: e.title,
          artist: e.uploader || e.channel || 'Unknown',
          duration: e.duration,
          thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
        })));
      } catch { reject(new Error('Could not parse liked songs')); }
    });
  });
}

function detectBrowsers() {
  return new Promise(resolve => {
    const list = [
      { id: 'chrome',   name: 'Google Chrome',  cmd: 'google-chrome --version 2>/dev/null || google-chrome-stable --version 2>/dev/null' },
      { id: 'chromium', name: 'Chromium',        cmd: 'chromium-browser --version 2>/dev/null || chromium --version 2>/dev/null' },
      { id: 'firefox',  name: 'Firefox',         cmd: 'firefox --version 2>/dev/null' },
      { id: 'edge',     name: 'Microsoft Edge',  cmd: 'microsoft-edge --version 2>/dev/null' },
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

module.exports = { loadConfig, saveConfig, getCookieArgs, testBrowserCookies, testCookieFile, fetchLikedSongs, detectBrowsers, COOKIES_PATH };
