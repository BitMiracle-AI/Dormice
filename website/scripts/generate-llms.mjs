// Emits the AI-readable docs layer into out/ after `next build`:
//
//   out/llms.txt         grouped index of every docs page (llms.txt convention)
//   out/llms-full.txt    all pages concatenated, sidebar order
//   out/docs/<slug>.md   one plain-markdown file per page
//
// content/docs/meta.json stays the single decision point for grouping and
// order (same as src/lib/docs.ts); the assertions below fail the build when
// the directory and meta.json drift. Links default to the production origin
// (the same literal as SITE_URL in src/lib/site.ts — this script cannot
// import TS); set SITE_URL in the environment only to preview against
// another origin.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const contentDir = path.join(websiteDir, 'content/docs');
const outDir = path.join(websiteDir, 'out');

const siteUrl = (process.env.SITE_URL ?? 'https://dormice.dev').replace(
  /\/+$/,
  '',
);

/** Parse an .mdx file into { title, description, body } or throw naming the file. */
async function parseDoc(name) {
  const raw = await readFile(path.join(contentDir, `${name}.mdx`), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match)
    throw new Error(`content/docs/${name}.mdx has no frontmatter block`);
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^(title|description):\s*(.+)$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  for (const key of ['title', 'description']) {
    if (!fields[key])
      throw new Error(
        `content/docs/${name}.mdx frontmatter is missing "${key}"`,
      );
  }
  return {
    title: fields.title,
    description: fields.description,
    body: raw.slice(match[0].length).trim(),
  };
}

const meta = JSON.parse(
  await readFile(path.join(contentDir, 'meta.json'), 'utf8'),
);
const listed = meta.groups.flatMap((group) => group.pages);

// Both directions, mirroring src/lib/docs.ts: every listed page has a file,
// every file is listed.
const onDisk = (await readdir(contentDir))
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => f.slice(0, -4));
for (const name of listed) {
  if (!onDisk.includes(name)) {
    throw new Error(
      `content/docs/meta.json lists "${name}" but content/docs/${name}.mdx does not exist`,
    );
  }
}
for (const name of onDisk) {
  if (!listed.includes(name)) {
    throw new Error(
      `content/docs/${name}.mdx exists but content/docs/meta.json does not list it`,
    );
  }
}

// out/ must already exist — this script only decorates a finished export.
try {
  await readdir(outDir);
} catch {
  throw new Error(
    `${outDir} not found — run \`next build\` first (the build script chains this)`,
  );
}

const docs = new Map(
  await Promise.all(listed.map(async (name) => [name, await parseDoc(name)])),
);
// The rendered page prepends the frontmatter title and description; the .md
// rendition does the same so both say exactly the same thing.
const asMarkdown = (doc) =>
  `# ${doc.title}\n\n${doc.description}\n\n${doc.body}\n`;
const mdPath = (name) => `${siteUrl}/docs/${name}.md`;

const index = [
  `# Dormice`,
  ``,
  `> ${docs.get('index').description}`,
  ``,
  `Every page below is served as plain markdown at the linked .md path;`,
  `[/llms-full.txt](${siteUrl}/llms-full.txt) is all of them in one file.`,
  ``,
  ...meta.groups.flatMap((group) => [
    `## ${group.title}`,
    ``,
    ...group.pages.map((name) => {
      const doc = docs.get(name);
      return `- [${doc.title}](${mdPath(name)}): ${doc.description}`;
    }),
    ``,
  ]),
].join('\n');

const full = listed.map((name) => asMarkdown(docs.get(name))).join('\n---\n\n');

await mkdir(path.join(outDir, 'docs'), { recursive: true });
await writeFile(path.join(outDir, 'llms.txt'), index);
await writeFile(path.join(outDir, 'llms-full.txt'), full);
for (const name of listed) {
  await writeFile(
    path.join(outDir, 'docs', `${name}.md`),
    asMarkdown(docs.get(name)),
  );
}

console.log(
  `llms.txt + llms-full.txt + ${listed.length} .md pages → ${path.relative(websiteDir, outDir)}/`,
);
