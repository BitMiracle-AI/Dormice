import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Static export, pinned from day one: the site must stay deployable as
  // plain files anywhere (GitHub Pages, an object store, any CDN) and never
  // grow a dependency on a Node server or a specific host.
  output: 'export',
  // A static export has no image-optimization server.
  images: { unoptimized: true },
};

export default withMDX(config);
