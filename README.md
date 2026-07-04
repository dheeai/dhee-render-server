# dhee-render-server

An HTTP render service for **web_motion** compositions. It wraps the same deterministic
`renderComposition` engine used by `dhee-runner-web-motion`, but runs the heavy
headless-Chromium frame render **where the cores (and GPU) are** — so dhee-core (e.g. a
16GB M4) can offload it to a many-core box (e.g. a Ryzen 9 9900X + RTX 5090).

## Why
The frame render (per frame: `seek(t)` → screenshot) is CPU/RAM-heavy. Measured: 6 worker
browsers on a 16GB M4 (4 perf cores) **regress** vs serial (they swap). The same fan-out on
a 12C/24T box with workstation RAM runs 12–16 workers near-linearly — a ~30-min M4 render
becomes ~3–5 min. WebGL/3D scenes additionally want the box's hardware GL (not SwiftShader).

## Run (on the box)
```bash
git clone https://github.com/dheeai/dhee-render-server && cd dhee-render-server
npm install                      # pulls dhee-runner-web-motion + puppeteer-core
# ensure a Chromium is present (DHEE_CHROME / CHROME_PATH), fonts installed
WM_WORKERS=12 PORT=8787 npm start
```
Expose `:8787` on the tailnet (or add a `/render` route to the existing :9000 gateway).
Hardware-GL (for WebGL/3D): launch Chromium with `--use-gl=angle --use-angle=gl` +
NVIDIA userspace; otherwise it falls back to SwiftShader (still correct, just CPU-bound).

## Use (from dhee-core / the Mac)
```bash
export WM_RENDER_ENDPOINT=http://<box-host>:8787
pnpm dhee run <project>          # video.web_motion / web.seq now render on the box
```
`renderComposition` (in dhee-runner-web-motion) auto-offloads when `WM_RENDER_ENDPOINT` is
set; unset → renders locally. Author-time lint stays local (it uses `lintComposition`, not
`renderComposition`) — only the final frame render offloads.

## API
- `GET /healthz` → `{ ok, workers, chrome }`
- `POST /render` `{ spec, audioB64?, scale? }` → `{ ok, mp4B64, frames, seconds, renderMs }`
  - `spec` = a web_motion composition (`{markup|component, theme, size, fps, dur, beats?}`).
  - **Assets:** a `spec.markup` that references local `photo`/`clip` `src=file://…` needs
    those files on the box. Graphics-only compositions are self-contained (no plumbing).
    Ground assets (Krea2 stills / LTX clips / SAM masks / meshes) will be generated on the
    box, so they're already co-located when grounds land.

## Determinism
Unchanged: `seek(t)` is a pure function of `t`; frames are identical regardless of which
worker (or machine) renders them.
