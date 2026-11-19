// Serialization (JSON / XML) and parsing of service maps in Node.
import { XMLParser } from 'fast-xml-parser';
import type { ServiceMap } from './model.ts';
import { toXml, fromXmlTree, type XEl } from './xmlmodel.ts';

export type Format = 'json' | 'xml';

export function serialize(map: ServiceMap, format: Format = 'json'): string {
  return format === 'xml' ? toXml(map) : JSON.stringify(map, null, 2) + '\n';
}

export function parseMap(text: string): ServiceMap {
  const t = text.trimStart();
  if (t.startsWith('<')) return fromXmlTree(parseXmlTree(t));
  const m = JSON.parse(t);
  if (!m || !Array.isArray(m.nodes) || !Array.isArray(m.edges)) throw new Error('Not a clownfish service map');
  return m;
}

export function parseXmlTree(text: string): XEl {
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });
  const raw = parser.parse(text) as any[];
  const conv = (o: any): XEl | undefined => {
    const name = Object.keys(o).find((k) => k !== ':@');
    if (!name || name === '#text' || name === '?xml') return undefined;
    const attrs: Record<string, string> = { ...(o[':@'] ?? {}) };
    const content: any[] = o[name] ?? [];
    const children = content.map(conv).filter((x): x is XEl => !!x);
    const text = content.filter((c) => '#text' in c).map((c) => String(c['#text'])).join('');
    return { name, attrs, children, text: children.length ? undefined : text };
  };
  const root = raw.map(conv).find((x) => x && x.name === 'serviceMap');
  if (!root) throw new Error('No <serviceMap> root element');
  return root;
}
