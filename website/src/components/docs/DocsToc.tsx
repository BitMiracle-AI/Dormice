'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface TocItem {
  id: string;
  text: string;
  depth: number;
}

// Reads headings from the rendered article (single source: the DOM the
// reader sees) and highlights the one currently in view.
export function DocsToc() {
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const article = document.querySelector('[data-docs-article]');
    if (!article) return;
    const headings = Array.from(article.querySelectorAll('h2, h3')).filter(
      (heading) => heading.id,
    );
    setItems(
      headings.map((heading) => ({
        id: heading.id,
        text: heading.textContent ?? '',
        depth: heading.tagName === 'H2' ? 2 : 3,
      })),
    );

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      // A heading counts as "current" while it sits in the top fifth of
      // the viewport.
      { rootMargin: '0% 0% -80% 0%' },
    );
    for (const heading of headings) observer.observe(heading);
    return () => observer.disconnect();
  }, []);

  if (items.length === 0) return null;

  return (
    <nav className="text-sm">
      <p className="mb-2 font-medium">On this page</p>
      <ul className="flex flex-col gap-1.5 border-l">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={cn(
                '-ml-px block border-l border-transparent pl-3 text-muted-foreground transition-colors hover:text-foreground',
                item.depth === 3 && 'pl-6',
                activeId === item.id && 'border-primary text-foreground',
              )}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
