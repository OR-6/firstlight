/**
 * The public origin of a request. Behind a proxy (Render) the request URL is
 * the internal address, so prefer the forwarded host and protocol. Values are
 * validated so a forged header can't produce a non-http(s) or malformed URL.
 */
export function requestOrigin(headers: { get(name: string): string | null }, url: string): string {
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null;
  const host = first(headers.get('x-forwarded-host')) ?? first(headers.get('host'));
  const proto = first(headers.get('x-forwarded-proto')) ?? new URL(url).protocol.replace(':', '');
  if (host && /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) && (proto === 'http' || proto === 'https')) return `${proto}://${host}`;
  return new URL(url).origin;
}
