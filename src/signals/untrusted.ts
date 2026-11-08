/**
 * Unstructured text the agent reads (SPEC §5.1 `untrustedText[]`).
 * Everything here is UNTRUSTED: it may contain instructions, and nothing in
 * the system may act on them. The real sources are USGS narrative products
 * (public domain). Red-team payloads are added on top, labelled as such.
 */
export type UntrustedText = {
  id: string;
  source: string;
  /** 'usgs' for real USGS products; 'redteam' for injected attack payloads. */
  origin: 'usgs' | 'news' | 'redteam';
  text: string;
};

const MAX_TEXT_CHARS = 4000;

/** Minimal HTML → plain text for USGS "general-text" products. Links are dropped. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|h\d|li|ul|ol|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

type Product = { source?: string; contents?: Record<string, { contentType?: string; bytes?: string }> };

/** Pull the USGS "general-text" (key points) and "impact-text" products out of an FDSN event detail. */
export function usgsTextsFromDetail(detail: unknown): UntrustedText[] {
  const products = (detail as { properties?: { products?: Record<string, Product[]> } })?.properties?.products ?? {};
  const out: UntrustedText[] = [];
  const take = (type: string, label: string) => {
    for (const [i, p] of (products[type] ?? []).entries()) {
      for (const c of Object.values(p.contents ?? {})) {
        if (!c.bytes) continue;
        const text = (c.contentType === 'text/plain' ? c.bytes : htmlToText(c.bytes)).slice(0, MAX_TEXT_CHARS);
        if (text.trim()) out.push({ id: `usgs-${type}-${i}`, source: `${label} (USGS, ${p.source ?? 'unknown'} network)`, origin: 'usgs', text });
      }
    }
  };
  take('general-text', 'USGS key points');
  take('impact-text', 'USGS impact summary');
  return out;
}

/**
 * Render untrusted texts for the agent inside delimiters it can't forge:
 * angle brackets inside the text are neutralised, so a payload can't close
 * the wrapper and pretend to be a system or tool message.
 */
export function wrapUntrusted(items: readonly UntrustedText[]): string {
  if (items.length === 0) return 'No untrusted text available for this event.';
  return items
    .map((t) => {
      const body = t.text.replace(/</g, '‹').replace(/>/g, '›');
      const attr = (s: string) => s.replace(/["<>]/g, '');
      return `<untrusted_text id="${attr(t.id)}" source="${attr(t.source)}">\n${body}\n</untrusted_text>`;
    })
    .join('\n\n');
}
