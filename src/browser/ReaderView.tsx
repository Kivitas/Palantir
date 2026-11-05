import { createElement, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ElementNode, ReaderNode } from './readerTree';

interface ReaderViewProps {
  nodes: ReaderNode[];
  /** Called for a link the user activates. newTab is true for Ctrl/Cmd-click or middle-click. */
  onOpen: (url: string, newTab: boolean) => void;
}

/**
 * Renders the reader tree as React elements. No markup strings, no raw HTML insertion, no
 * scripts, no forms and no embedded frames. Links go through onOpen, never a browser navigation.
 */
export function ReaderView({ nodes, onOpen }: ReaderViewProps) {
  return (
    <article className="reader" aria-label="Page content">
      {nodes.map((node, i) => renderNode(node, String(i), onOpen))}
    </article>
  );
}

function renderNode(node: ReaderNode, key: string, onOpen: ReaderViewProps['onOpen']): ReactNode {
  if (node.type === 'text') return node.text;
  return renderElement(node, key, onOpen);
}

function renderElement(node: ElementNode, key: string, onOpen: ReaderViewProps['onOpen']): ReactNode {
  if (node.tag === 'img') {
    if (!node.src) return null;
    return (
      <img
        key={key}
        src={node.src}
        alt={node.attrs.alt ?? ''}
        title={node.attrs.title}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
    );
  }

  const children = node.children.map((child, i) => renderNode(child, `${key}.${i}`, onOpen));

  if (node.tag === 'a' && node.href) {
    const href = node.href;
    const open = (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      onOpen(href, e.ctrlKey || e.metaKey);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onOpen(href, e.ctrlKey || e.metaKey);
      }
    };
    return (
      <a
        key={key}
        className="reader-link"
        role="link"
        tabIndex={0}
        title={node.attrs.title ?? href}
        onClick={open}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onOpen(href, true);
          }
        }}
        onKeyDown={onKeyDown}
      >
        {children}
      </a>
    );
  }

  // Allowlisted tag. The tag name comes from a fixed set (readerTree.ts), and the props are the
  // allowlisted attributes only.
  return createElement(node.tag, { key, ...node.attrs }, ...children);
}
