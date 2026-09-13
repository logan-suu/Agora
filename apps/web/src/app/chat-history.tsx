'use client';

import * as React from 'react';
import { useId, useLayoutEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD = 32;

export function ChatHistory({
  messageIds,
  children,
}: {
  messageIds: readonly string[];
  children: React.ReactNode;
}) {
  const regionId = useId();
  const viewport = React.useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const knownIds = useRef(new Set(messageIds));
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(0);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const added = messageIds.filter((id) => !knownIds.current.has(id)).length;
    knownIds.current = new Set(messageIds);
    if (following.current) {
      element.scrollTop = element.scrollHeight;
      setUnread(0);
    } else if (added > 0) {
      setUnread((count) => count + added);
    }
  }, [messageIds]);

  useLayoutEffect(() => {
    const element = viewport.current;
    const contents = content.current;
    if (element === null || contents === null) return;
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    observer.observe(contents);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const element = viewport.current;
    if (element === null) return;
    const atBottom =
      element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_THRESHOLD;
    following.current = atBottom;
    setAway(!atBottom);
    if (atBottom) setUnread(0);
  }

  function jumpToLatest() {
    const element = viewport.current;
    if (element === null) return;
    following.current = true;
    element.focus({ preventScroll: true });
    element.scrollTop = element.scrollHeight;
    setAway(false);
    setUnread(0);
  }

  return (
    <div className="chat-history">
      <section
        id={regionId}
        ref={viewport}
        className="message-list"
        aria-label="Messages"
        aria-live="polite"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The history region supports keyboard scrolling.
        tabIndex={0}
        onScroll={onScroll}
      >
        <div ref={content}>{children}</div>
      </section>
      {away ? (
        <button
          type="button"
          className="chat-latest-button"
          aria-controls={regionId}
          onClick={jumpToLatest}
        >
          {unread > 0 ? `${unread} new ${unread === 1 ? 'message' : 'messages'} · ` : ''}
          Back to latest
        </button>
      ) : null}
    </div>
  );
}
