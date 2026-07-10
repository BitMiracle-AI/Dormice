import createMDX from '@next/mdx';

/** @type {import('next').NextConfig} */
const config = {
  // Static export, pinned from day one: the site must stay deployable as
  // plain files anywhere (GitHub Pages, an object store, any CDN) and never
  // grow a dependency on a Node server or a specific host.
  output: 'export',
  // A static export has no image-optimization server.
  images: { unoptimized: true },
};

const withMDX = createMDX({
  options: {
    // Plugins by package name, not imported functions: Turbopack requires
    // loader options to be serializable.
    remarkPlugins: [
      ['remark-gfm'],
      ['remark-frontmatter'],
      ['remark-mdx-frontmatter'],
    ],
    rehypePlugins: [
      ['rehype-slug'],
      [
        '@shikijs/rehype',
        {
          themes: { light: 'github-light', dark: 'github-dark' },
          // Emit both palettes as CSS variables; global.css picks one per
          // color scheme.
          defaultColor: false,
        },
      ],
    ],
  },
});

export default withMDX(config);
