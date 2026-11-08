import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '@/agentapi/mcp';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Browser-based agents can call the MCP endpoint too. Nothing here is charged without a person approving on PayPal.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version',
};
const MAX_BYTES = 16_000;

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** MCP over Streamable HTTP, stateless: a fresh server and transport per request. */
export async function POST(req: Request): Promise<Response> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) {
    return withCors(Response.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request too large' }, id: null }, { status: 413 }));
  }
  const rt = firstlight();
  const server = buildMcpServer({ db: rt.db, donations: rt.donations });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(req));
  } finally {
    void server.close();
  }
}

/** Stateless server: no standalone SSE stream and no sessions to delete. */
function notAllowed(): Response {
  return withCors(
    Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Send JSON-RPC with POST.' }, id: null }, { status: 405, headers: { Allow: 'POST, OPTIONS' } }),
  );
}
export const GET = notAllowed;
export const DELETE = notAllowed;

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
