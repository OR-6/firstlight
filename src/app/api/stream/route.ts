import { firstlight, type LiveEvent } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Server-sent events: every audit append and demo reset, for live dashboards. */
export function GET(req: Request) {
  const bus = firstlight().bus;
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: LiveEvent) => controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      const ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 15_000);
      bus.on('live', send);
      cleanup = () => {
        clearInterval(ping);
        bus.off('live', send);
      };
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      controller.enqueue(enc.encode(': connected\n\n'));
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } });
}
