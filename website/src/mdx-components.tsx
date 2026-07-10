import type { MDXComponents } from 'mdx/types';

// Required by @next/mdx: every compiled MDX module resolves its components
// through this hook. Element overrides shared by all docs go here.
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return { ...components };
}
