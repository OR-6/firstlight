/**
 * Read-only probe of PayPal's hosted sandbox MCP server.
 *   npx tsx --env-file=.env scripts/probe-paypal-mcp.ts [ORDER_ID]
 * Lists the server's tools, then (if an order id is given) calls get_order
 * through the read-only allowlist and the Server SDK, and compares them.
 * Never prints the access token or any payer detail beyond "present".
 */
import { PayPalClient, loadPayPalConfig } from '../src/paypal/client';
import { HostedPayPalMcp } from '../src/paypal/hosted-mcp';
import { PayPalOrders } from '../src/paypal/orders';

async function main() {
  const config = loadPayPalConfig();
  const paypal = new PayPalClient(config);
  const mcp = new HostedPayPalMcp(async () => (await paypal.getToken()).accessToken);
  const orderId = process.argv[2];

  const t0 = Date.now();
  try {
    const tools = await mcp.listTools();
    console.log(`tools/list OK in ${Date.now() - t0} ms: ${tools.length} tools`);
    console.log(tools.map((t) => t.name).join(', '));
    const get = tools.find((t) => t.name === 'get_order');
    console.log('get_order input schema:', JSON.stringify(get?.inputSchema ?? null));
  } catch (err) {
    console.log(`tools/list FAILED after ${Date.now() - t0} ms: ${(err as Error).name}: ${(err as Error).message}`);
  }
  if (!orderId) return;

  const t1 = Date.now();
  try {
    const r = await mcp.getOrder(orderId);
    console.log(`hosted get_order OK in ${Date.now() - t1} ms:`, { ...r, payerId: r.payerId ? 'present' : null });
  } catch (err) {
    console.log(`hosted get_order FAILED after ${Date.now() - t1} ms: ${(err as Error).name}: ${(err as Error).message}`);
  }
  const t2 = Date.now();
  try {
    const r = await new PayPalOrders(config, { hostedMcp: false }).get(orderId);
    console.log(`SDK getOrder OK in ${Date.now() - t2} ms:`, { ...r, payerId: r.payerId ? 'present' : null });
  } catch (err) {
    console.log(`SDK getOrder FAILED after ${Date.now() - t2} ms: ${(err as Error).message}`);
  }
  // What receipts use: hosted MCP first, SDK fallback.
  const t3 = Date.now();
  const c = await new PayPalOrders(config).confirm(orderId);
  console.log(`receipt confirm() in ${Date.now() - t3} ms: source=${c.source} status=${c.status} capture=${c.captureId}${c.fallbackReason ? ` fallback because ${c.fallbackReason}` : ''}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
