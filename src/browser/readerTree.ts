/**
 * Turns the sanitised page HTML into a plain data tree using a strict allowlist.
 *
 * The HTML is parsed into an inert DOMParser document: scripts do not run and resources are not
 * fetched. Only the tags in ALLOWED_TAGS survive; unknown tags are unwrapped to their text;
 * SKIP_TAGS are dropped with their content. Links survive only as resolved http(s) URLs, and
 * images only when they point at this app's /browse?asset=1 proxy. The React layer renders this
 * tree and never receives markup.
 */
import { assetUrl, isHttpUrl } from './client';

export type ReaderNode = { type: 'text'; text: string } | ElementNode;

export interface ElementNode {
  type: 'element';
  tag: string;
  /** Set on links: the resolved http(s) target. Absent means the anchor is shown as plain text. */
  href?: string;
  /** Set on images: the proxied image URL. */
  src?: string;
  attrs: Record<string, string>;
  children: ReaderNode[];
}

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'i', 'img', 'ins', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section', 'small', 'span', 'strong', 'sub',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul',
]);

/** Dropped with all content. Nothing inside these is ever shown. */
const SKIP_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'svg',
  'math', 'video', 'audio', 'canvas', 'form', 'input', 'button', 'select', 'textarea', 'option', 'head', 'title',
  'meta', 'link', 'base', 'dialog',
]);

/** Attributes copied through when present, with their React prop names. */
const ATTR_MAP: Record<string, string> = {
  title: 'title',
  alt: 'alt',
  lang: 'lang',
  dir: 'dir',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  datetime: 'dateTime',
};

const MAX_NODES = 20_000;
const MAX_DEPTH = 120;

/** Parses sanitised HTML into a ReaderNode list. Capped on node count and depth. */
export function buildReaderTree(html: string): ReaderNode[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const budget = { nodes: 0 };
  return convertChildren(doc.body, budget, 0);
}

/** Visible text of a tree, whitespace collapsed, cut to `limit` characters. */
export function treeText(nodes: ReaderNode[], limit: number): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (list: ReaderNode[]): void => {
    for (const node of list) {
      if (length >= limit) return;
      if (node.type === 'text') {
        parts.push(node.text);
        length += node.text.length;
      } else {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return parts.join('').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function convertChildren(parent: Node, budget: { nodes: number }, depth: number): ReaderNode[] {
  const out: ReaderNode[] = [];
  if (depth > MAX_DEPTH) return out;
  for (const child of Array.from(parent.childNodes)) {
    if (budget.nodes >= MAX_NODES) break;
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? '';
      if (text) {
        budget.nodes += 1;
        out.push({ type: 'text', text });
      }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const el = child as Element;
    const tag = el.localName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown but harmless wrapper: keep its content, drop the element.
      out.push(...convertChildren(el, budget, depth + 1));
      continue;
    }

    budget.nodes += 1;
    const attrs: Record<string, string> = {};
    for (const [name, prop] of Object.entries(ATTR_MAP)) {
      const value = el.getAttribute(name);
      if (value !== null && value.length <= 200) attrs[prop] = value;
    }

    const node: ElementNode = { type: 'element', tag, attrs, children: [] };

    if (tag === 'a') {
      const href = el.getAttribute('data-aegis-href');
      if (href && isHttpUrl(href)) node.href = href;
    } else if (tag === 'img') {
      const src = el.getAttribute('src');
      // Only the proxy's own image URLs. The page's original src has already been removed.
      if (src && src.startsWith('/browse?asset=1&url=')) {
        const target = decodeAssetTarget(src);
        if (target && isHttpUrl(target)) node.src = assetUrl(target);
      }
      if (!node.src) continue;
      out.push(node);
      continue;
    }

    node.children = convertChildren(el, budget, depth + 1);
    out.push(node);
  }
  return out;
}

function decodeAssetTarget(src: string): string | null {
  const match = /[?&]url=([^&]*)/.exec(src);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
