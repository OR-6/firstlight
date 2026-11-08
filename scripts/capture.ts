/**
 * Screenshot pages of Firstlight with the locally installed Google Chrome,
 * driven over the DevTools protocol (no browser download, no extra package).
 * Used for the README image and the demo-video shots (docs/VIDEO_PLAN.md).
 *
 *   npx tsx scripts/capture.ts <url> <out.png> [--w 1920] [--h 1080] [--scale 2] [--wait 6000] [--js "<code run before capture>"] [--after 1500]
 *
 * Motion clip of the real app (for the video): frames are saved as numbered
 * JPEGs with a timestamps.json, so the editor can play them back at real speed.
 *
 *   npx tsx scripts/capture.ts <url> <out-dir> --record 12000 [--js "<code run once recording starts>"]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: tsx scripts/capture.ts <url> <out.png> [--w 1920] [--h 1080] [--scale 2] [--wait 6000] [--js "..."] [--after 1500]');
  process.exit(2);
}
const opt = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const width = Number(opt('w', '1920'));
const height = Number(opt('h', '1080'));
const scale = Number(opt('scale', '2'));
const wait = Number(opt('wait', '6000'));
const after = Number(opt('after', '1500'));
const js = opt('js', '');
const record = Number(opt('record', '0'));
const port = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fl-capture-'))}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--force-color-profile=srgb',
  'about:blank',
]);

try {
  let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 50 && !targets.length; i++) {
    await sleep(200);
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json(), () => []);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('Chrome did not start');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: unknown };
    if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
  });
  const send = <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result as T)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const events = new Map<string, (params: Record<string, unknown>) => void>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as { method?: string; params?: Record<string, unknown> };
    if (m.method && events.has(m.method)) events.get(m.method)!(m.params ?? {});
  });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 768 });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(wait);
  if (record > 0) {
    mkdirSync(out, { recursive: true });
    const stamps: { file: string; t: number }[] = [];
    let n = 0;
    events.set('Page.screencastFrame', (p) => {
      const file = `frame-${String(++n).padStart(5, '0')}.jpg`;
      writeFileSync(join(out, file), Buffer.from(String(p.data), 'base64'));
      stamps.push({ file, t: Number((p.metadata as { timestamp: number }).timestamp) });
      void send('Page.screencastFrameAck', { sessionId: p.sessionId });
    });
    await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: width * scale, maxHeight: height * scale, everyNthFrame: 1 });
    if (js) void send('Runtime.evaluate', { expression: `(async () => { ${js} })()`, awaitPromise: true });
    await sleep(record);
    await send('Page.stopScreencast');
    writeFileSync(join(out, 'timestamps.json'), JSON.stringify({ width: width * scale, height: height * scale, frames: stamps }, null, 1));
    console.log(`recorded ${stamps.length} frames to ${out}`);
    ws.close();
    process.exit(0);
  }
  if (js) {
    await send('Runtime.evaluate', { expression: `(async () => { ${js} })()`, awaitPromise: true });
    await sleep(after);
  }
  const shot = await send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${out} (${width}x${height} @${scale}x)`);
  ws.close();
} finally {
  chrome.kill();
}
