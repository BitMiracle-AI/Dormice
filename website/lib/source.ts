import { loader } from 'fumadocs-core/source';
import { docs } from '@/.source/server';

// The one content loader: page tree, slugs and page data all come from here.
export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
