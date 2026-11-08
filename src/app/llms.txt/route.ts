import { llmsTxt } from '@/agentapi/catalog';
import { baseUrl } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return new Response(llmsTxt(baseUrl(req)), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
}
