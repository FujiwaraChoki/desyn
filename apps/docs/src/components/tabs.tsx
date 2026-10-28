"use client";

import {
  Children,
  isValidElement,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

interface TabProps {
  label: string;
  children: ReactNode;
}

/** A single tab panel. Only meaningful inside <Tabs>. */
export function Tab({ children }: TabProps) {
  return <>{children}</>;
}

/**
 * Accessible tabs (WAI-ARIA tabs pattern, automatic activation). All panels are rendered so the
 * content is in the HTML for search engines and the static search index; inactive ones are hidden.
 */
export function Tabs({ children }: { children: ReactNode }) {
  const tabs = Children.toArray(children).filter(
    (child): child is ReactElement<TabProps> =>
      isValidElement<TabProps>(child) && typeof child.props.label === "string",
  );
  const [active, setActive] = useState(0);
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);

  function focusTab(index: number) {
    const next = (index + tabs.length) % tabs.length;
    setActive(next);
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") focusTab(active + 1);
    else if (event.key === "ArrowLeft") focusTab(active - 1);
    else if (event.key === "Home") focusTab(0);
    else if (event.key === "End") focusTab(tabs.length - 1);
    else return;
    event.preventDefault();
  }

  return (
    <div className="tabs">
      <div className="tab-list" role="tablist" ref={listRef} onKeyDown={onKeyDown}>
        {tabs.map((tab, i) => (
          <button
            key={tab.props.label}
            type="button"
            role="tab"
            id={`${id}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${id}-panel-${i}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
          >
            {tab.props.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div
          key={tab.props.label}
          role="tabpanel"
          id={`${id}-panel-${i}`}
          aria-labelledby={`${id}-tab-${i}`}
          hidden={i !== active}
          className="tab-panel"
        >
          {tab.props.children}
        </div>
      ))}
    </div>
  );
}
