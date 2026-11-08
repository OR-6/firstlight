import { manifest } from '@/agentapi/catalog';
import { baseUrl } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return Response.json(manifest(baseUrl(req)), { headers: { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' } });
}
