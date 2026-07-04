#!/usr/bin/env node
// dhee-render-server — a GENERIC headless-Chromium HTML->video appliance.
//
// It knows NOTHING about any DSL, the dhee app, or where files live. Its entire contract:
//   GET  /healthz  -> { ok, workers, chrome }
//   POST /render  { html, fps, size:[w,h], dur?, scale?, audioB64? }
//                 -> { ok, mp4B64, frames, seconds, renderMs }
//     html = a FULLY SELF-CONTAINED page (all assets already inlined as data: URIs) that
//            implements the seekable-animation protocol:
//              window.seek(tSeconds)  — set the virtual clock; may return a Promise
//              window.__dur           — total duration in seconds (used when `dur` is omitted)
//            We load it, step the clock frame-by-frame (seek -> screenshot), then ffmpeg the PNG
//            sequence to mp4 and (optionally) mux the audio.
//
// All DSL->HTML/WebGL compilation and asset inlining happen in the CLIENT (web_motion). This
// server never changes when the DSL/engine changes — iterate freely without redeploying it.
// Determinism (seek(t) is a pure function of t) is what makes the parallel worker split safe.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

const PORT = Number(process.env.PORT) || 8787;
const WORKERS = Number(process.env.WM_WORKERS) || 12; // tuned for a 12C/24T box; override per host
const FFMPEG = process.env.FFMPEG || process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_BODY = 512 * 1024 * 1024; // self-contained html with inlined grounds gets large
const CHROME_CANDIDATES = [
  process.env.DHEE_CHROME, process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function resolveChrome() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  throw new Error('no Chrome found — set DHEE_CHROME to a Chrome/Chromium binary');
}

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: resolveChrome(),
    headless: true, // new headless — WebGL via SwiftShader (scene3d), fine for CSS too
    args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars', '--disable-lcd-text',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
}

// load a self-contained page from a temp file (file:// is the proven load path) and wait for the
// seek protocol. There are no external asset refs — everything is inlined by the client.
async function openPage(browser, html, size, scale) {
  const dir = mkdtempSync(join(tmpdir(), 'r-page-'));
  const file = join(dir, 'c.html');
  writeFileSync(file, html);
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1], deviceScaleFactor: scale });
  await page.goto('file://' + file, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction('typeof window.seek === "function"', { timeout: 20000 });
  await page.waitForFunction('window.__ready === true', { timeout: 20000 }).catch(() => {}); // best-effort
  const close = page.close.bind(page);
  page.close = async () => { await close(); rmSync(dir, { recursive: true, force: true }); };
  return page;
}

// render a contiguous frame range [lo,hi) in its OWN browser (isolated — sidesteps the
// WebGL-in-shared-browser deadlock), mounting once and seeking sequentially.
async function renderRange(html, size, scale, fps, lo, hi, frameDir, log, wi) {
  const browser = await launchBrowser();
  try {
    const page = await openPage(browser, html, size, scale);
    for (let i = lo; i < hi; i++) {
      await page.evaluate((tt) => window.seek(tt), i / fps); // await: seek may be async (video grounds)
      await page.screenshot({ path: join(frameDir, `f${String(i).padStart(5, '0')}.png`), type: 'png', optimizeForSpeed: true });
      if (log && (i - lo) % (fps * 2) === 0) log(`render: worker ${wi} frame ${i - lo}/${hi - lo}`);
    }
    await page.close();
  } finally { await browser.close(); }
}

async function renderHtmlToMp4({ html, size, fps, dur, scale, audioPath, outPath, log }) {
  // duration: prefer the client-provided value; else read window.__dur off the page.
  if (!dur) {
    const b0 = await launchBrowser();
    try { const p0 = await openPage(b0, html, size, scale); dur = Number(await p0.evaluate('window.__dur || 0')) || 6; await p0.close(); }
    finally { await b0.close(); }
  }
  const frames = Math.max(1, Math.round(fps * dur));
  const frameDir = mkdtempSync(join(tmpdir(), 'r-frames-'));
  const t0 = Date.now();
  const W = Math.max(1, WORKERS);
  try {
    if (W <= 1) {
      await renderRange(html, size, scale, fps, 0, frames, frameDir, log, 0);
    } else {
      const per = Math.ceil(frames / W);
      const jobs = [];
      for (let w = 0; w < W; w++) { const lo = w * per, hi = Math.min(frames, lo + per); if (lo < hi) jobs.push(renderRange(html, size, scale, fps, lo, hi, frameDir, log, w)); }
      log && log(`render: ${frames} frames across ${jobs.length} workers…`);
      await Promise.all(jobs);
    }
    log && log(`render: ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s (${W}w)`);
    mkdirSync(dirname(outPath), { recursive: true });
    const silent = audioPath ? outPath.replace(/\.mp4$/i, '') + '.silent.mp4' : outPath;
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error',
      '-framerate', String(fps), '-i', join(frameDir, 'f%05d.png'),
      '-vf', `scale=${size[0]}:${size[1]}:flags=lanczos`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', silent]);
    if (audioPath) {
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', silent, '-i', audioPath,
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outPath]);
      try { unlinkSync(silent); } catch { /* ignore */ }
    }
  } finally { rmSync(frameDir, { recursive: true, force: true }); }
  return { frames, seconds: dur };
}

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
    let chrome = null; try { chrome = resolveChrome(); } catch { /* report null */ }
    return send(res, 200, { ok: true, workers: WORKERS, chrome, service: 'dhee-render-server (generic html->video)' });
  }
  if (req.method !== 'POST' || req.url !== '/render') return send(res, 404, { error: 'not found' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > MAX_BODY) { req.destroy(); } });
  req.on('end', async () => {
    let job; try { job = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid JSON body' }); }
    if (!job || !job.html) return send(res, 400, { error: 'missing html (POST a self-contained page implementing window.seek/window.__dur)' });
    const dir = mkdtempSync(join(tmpdir(), 'dhee-render-'));
    const out = join(dir, 'out.mp4');
    try {
      let audioPath = null;
      if (job.audioB64) { audioPath = join(dir, 'audio.wav'); writeFileSync(audioPath, Buffer.from(job.audioB64, 'base64')); }
      const t0 = Date.now();
      const r = await renderHtmlToMp4({
        html: job.html, size: job.size || [1280, 720], fps: Number(job.fps) || 30,
        dur: Number(job.dur) || 0, scale: Number(job.scale) || 2, audioPath, outPath: out,
        log: (m) => process.stderr.write(m + '\n'),
      });
      const mp4B64 = readFileSync(out).toString('base64');
      send(res, 200, { ok: true, mp4B64, frames: r.frames, seconds: r.seconds, renderMs: Date.now() - t0 });
    } catch (e) {
      send(res, 500, { error: String((e && e.message) || e) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

server.listen(PORT, () => process.stderr.write(`dhee-render-server (generic html->video) listening on :${PORT} (workers=${WORKERS})\n`));
