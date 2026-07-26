"use client";

import { useEffect, useRef, type AnchorHTMLAttributes, type ReactNode } from "react";

/**
 * An anchor whose href is a `javascript:` bookmarklet.
 *
 * React refuses to render these. `sanitizeURL` silently swaps any javascript:
 * href for `javascript:throw new Error('React has blocked a javascript: URL as
 * a security precaution.')` — the link still looks right and still drags to the
 * bookmarks bar, so the damage only surfaces later as that error thrown on
 * whatever page the bookmark is clicked on.
 *
 * The URL therefore never goes through React. It's attached after render, and
 * again on dragstart, which is where the bookmarks bar actually reads it.
 */
type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children"> & {
  href: string;
  children: ReactNode;
};

export function BookmarkletLink({ href, children, onDragStart, onClick, ...rest }: Props) {
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    ref.current?.setAttribute("href", href);
  }, [href]);

  return (
    <a
      {...rest}
      ref={ref}
      onDragStart={(e) => {
        // Belt and braces: a drag carries this payload rather than the
        // attribute, so the bookmark is correct even if the href is rewritten.
        e.dataTransfer.setData("text/uri-list", href);
        e.dataTransfer.setData("text/plain", href);
        onDragStart?.(e);
      }}
      // Clicking it here would inject the connector into our own page.
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
    >
      {children}
    </a>
  );
}
