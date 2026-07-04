#!/usr/bin/env node
// dhee-render-server — HTTP wrapper around web_motion's renderComposition, deployed on a
// many-core (+ GPU) box so dhee-core can OFFLOAD the heavy headless-Chromium frame render.
//
// Why: the frame render (seek -> screenshot per frame) is CPU/RAM-heavy. A 16GB M4 (4 perf
// cores) thrashes past ~2 parallel browsers; a 12C/24T Ryzen 9900X (+ 5090 hardware-GL) runs
// 12-16 workers near-linearly. Same deterministic engine, just run where the cores are.
//
// Contract:
//   GET  /healthz            -> { ok, workers, chrome }
//   POST /render  {spec, audioB64?, scale?}  -> { ok, mp4B64, frames, seconds, renderMs }
//     spec = a web_motion composition spec ({markup|component, theme, size, fps, dur, beats?}).
//     NOTE: spec.markup that references LOCAL asset paths (photo/clip src=file://…) requires
//     those files to exist ON THIS BOX. Graphics-only compositions are self-contained and
//     render remotely with zero extra plumbing (the current explainers). Ground assets ride
//     along once they're generated here too (they will be — Krea2/LTX/masks are box-side).
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderComposition, resolveChrome } from 'dhee-runner-web-motion/render';

const PORT = Number(process.env.PORT) || 8787;
const WORKERS = Number(process.env.WM_WORKERS) || 12; // tuned for a 12C/24T box; override per host
const MAX_BODY = 256 * 1024 * 1024;

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    let chrome = null; try { chrome = resolveChrome(); } catch { /* report null */ }
    return send(res, 200, { ok: true, workers: WORKERS, chrome });
  }
  if (req.method !== 'POST' || req.url !== '/render') return send(res, 404, { error: 'not found' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > MAX_BODY) { req.destroy(); } });
  req.on('end', async () => {
    let job; try { job = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid JSON body' }); }
    if (!job || !job.spec) return send(res, 400, { error: 'missing spec' });
    const dir = mkdtempSync(join(tmpdir(), 'dhee-render-'));
    const out = join(dir, 'out.mp4');
    try {
      let audioPath = null;
      if (job.audioB64) { audioPath = join(dir, 'audio.wav'); writeFileSync(audioPath, Buffer.from(job.audioB64, 'base64')); }
      const t0 = Date.now();
      const r = await renderComposition(job.spec, { outPath: out, audioPath, scale: Number(job.scale) || 2, workers: WORKERS, log: (m) => process.stderr.write(m + '\n') });
      const mp4B64 = readFileSync(out).toString('base64');
      send(res, 200, { ok: true, mp4B64, frames: r.frames, seconds: r.seconds, renderMs: Date.now() - t0 });
    } catch (e) {
      send(res, 500, { error: String((e && e.message) || e) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

server.listen(PORT, () => process.stderr.write(`dhee-render-server listening on :${PORT} (workers=${WORKERS})\n`));
