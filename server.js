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
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
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

// ASYNC JOBS: a render can run for many minutes, so we NEVER hold the HTTP connection open for
// its duration (that couples render time to fetch/proxy timeouts — the 300s failure). Instead:
//   POST /render      -> { jobId } immediately (202); render runs in the background
//   GET  /status/:id  -> { status: queued|running|done|error, frames?, seconds?, renderMs?, error? }
//   GET  /result/:id  -> the mp4 streamed as binary (video/mp4) once status=done
// Jobs run one-at-a-time (a single render already saturates all worker browsers). Finished jobs
// are swept after a TTL. State is in-memory — fine for a single-box appliance.
const JOB_TTL_MS = 60 * 60 * 1000; // keep a finished job's mp4 for an hour
const jobs = new Map(); // id -> { status, dir, outPath, frames, seconds, renderMs, error, tCreated, tEnd }
const queue = [];
let running = false;

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  job.status = 'running';
  const t0 = Date.now();
  try {
    const html = readFileSync(join(job.dir, 'page.html'), 'utf8');
    const audioPath = existsSync(join(job.dir, 'audio.wav')) ? join(job.dir, 'audio.wav') : null;
    const r = await renderHtmlToMp4({ html, size: job.size, fps: job.fps, dur: job.dur, scale: job.scale, audioPath, outPath: job.outPath, log: (m) => process.stderr.write(`[${job.id.slice(0, 8)}] ${m}\n`) });
    job.frames = r.frames; job.seconds = r.seconds; job.renderMs = Date.now() - t0; job.status = 'done'; job.tEnd = Date.now();
    process.stderr.write(`[${job.id.slice(0, 8)}] done: ${r.frames} frames in ${(job.renderMs / 1000).toFixed(1)}s\n`);
  } catch (e) {
    job.status = 'error'; job.error = String((e && e.message) || e); job.tEnd = Date.now();
    process.stderr.write(`[${job.id.slice(0, 8)}] ERROR: ${job.error}\n`);
  } finally {
    try { unlinkSync(join(job.dir, 'page.html')); } catch { /* free the big html asap */ }
    running = false; setImmediate(pump);
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.tEnd && now - job.tEnd > JOB_TTL_MS) { try { rmSync(job.dir, { recursive: true, force: true }); } catch { /* ignore */ } jobs.delete(id); }
  }
}
setInterval(sweep, 5 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
    let chrome = null; try { chrome = resolveChrome(); } catch { /* report null */ }
    return send(res, 200, { ok: true, workers: WORKERS, chrome, running, queued: queue.length, service: 'dhee-render-server (generic html->video, async)' });
  }

  // GET /status/:id
  let m = url.match(/^\/status\/([\w-]+)$/);
  if (req.method === 'GET' && m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'unknown jobId' });
    return send(res, 200, { status: job.status, frames: job.frames, seconds: job.seconds, renderMs: job.renderMs, error: job.error });
  }

  // GET /result/:id  -> stream the mp4 binary
  m = url.match(/^\/result\/([\w-]+)$/);
  if (req.method === 'GET' && m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'unknown jobId' });
    if (job.status !== 'done') return send(res, 409, { error: `job not done (status=${job.status})`, status: job.status });
    if (!existsSync(job.outPath)) return send(res, 410, { error: 'result expired/swept' });
    const stat = statSync(job.outPath);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': stat.size });
    return createReadStream(job.outPath).pipe(res);
  }

  // POST /render -> enqueue, return jobId immediately
  if (req.method === 'POST' && url === '/render') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) { req.destroy(); } });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid JSON body' }); }
      if (!j || !j.html) return send(res, 400, { error: 'missing html (POST a self-contained page implementing window.seek/window.__dur)' });
      const id = randomUUID();
      const dir = mkdtempSync(join(tmpdir(), 'dhee-render-'));
      writeFileSync(join(dir, 'page.html'), j.html);
      if (j.audioB64) writeFileSync(join(dir, 'audio.wav'), Buffer.from(j.audioB64, 'base64'));
      const job = { id, status: 'queued', dir, outPath: join(dir, 'out.mp4'), size: j.size || [1280, 720], fps: Number(j.fps) || 30, dur: Number(j.dur) || 0, scale: Number(j.scale) || 2, tCreated: Date.now() };
      jobs.set(id, job); queue.push(job); setImmediate(pump);
      return send(res, 202, { jobId: id, status: 'queued' });
    });
    return;
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => process.stderr.write(`dhee-render-server (generic html->video, async) listening on :${PORT} (workers=${WORKERS})\n`));
