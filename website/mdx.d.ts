declare module '*.mdx' {
  import type { MDXProps } from 'mdx/types';
  import type { JSX } from 'react';

  // Exported by remark-mdx-frontmatter from each document's YAML header.
  export const frontmatter: {
    title: string;
    description: string;
  };

  export default function MDXContent(props: MDXProps): JSX.Element;
}
