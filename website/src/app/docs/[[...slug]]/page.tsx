import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DocsToc } from '@/components/docs/DocsToc';
import { Button } from '@/components/ui/button';
import { docs, getDoc } from '@/lib/docs';

// Static export: every page below /docs is enumerated here, nothing is
// rendered on demand.
export const dynamicParams = false;

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export default async function Page(props: PageProps) {
  const params = await props.params;
  const doc = getDoc(params.slug);
  if (!doc) notFound();
  const { entry, Content, prev, next } = doc;

  return (
    <div className="flex items-start gap-10 py-8 lg:py-10">
      <div className="min-w-0 flex-1">
        <article
          data-docs-article
          className="prose prose-neutral max-w-none dark:prose-invert"
        >
          <h1>{entry.title}</h1>
          <p className="lead">{entry.description}</p>
          <Content />
        </article>
        <nav className="mt-10 flex items-center justify-between gap-4 border-t pt-6">
          {prev ? (
            <Button
              variant="ghost"
              className="text-muted-foreground"
              render={<Link href={prev.href} />}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} data-icon="inline-start" />
              {prev.title}
            </Button>
          ) : (
            <span />
          )}
          {next ? (
            <Button
              variant="ghost"
              className="text-muted-foreground"
              render={<Link href={next.href} />}
            >
              {next.title}
              <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
            </Button>
          ) : (
            <span />
          )}
        </nav>
      </div>
      <aside className="sticky top-20 hidden w-56 shrink-0 xl:block">
        <DocsToc />
      </aside>
    </div>
  );
}

export function generateStaticParams() {
  return docs.map((entry) => ({
    slug: entry.slug === '' ? [] : entry.slug.split('/'),
  }));
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const params = await props.params;
  const doc = getDoc(params.slug);
  if (!doc) notFound();
  return { title: doc.entry.title, description: doc.entry.description };
}
