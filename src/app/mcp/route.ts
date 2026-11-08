import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '@/agentapi/mcp';
import { firstlight } from '@/server/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** MCP over Streamable HTTP, stateless: a fresh server and transport per request. */
async function handle(req: Request): Promise<Response> {
  const rt = firstlight();
  const server = buildMcpServer({ db: rt.db, donations: rt.donations });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
