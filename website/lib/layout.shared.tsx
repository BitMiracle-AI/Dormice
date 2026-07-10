import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

// Chrome shared by every layout (home and docs): title, links, GitHub.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: 'Dormice' },
    githubUrl: 'https://github.com/BitMiracle-AI/Dormice',
    links: [{ text: 'Documentation', url: '/docs' }],
  };
}
