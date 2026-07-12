import { createFileRoute } from '@tanstack/react-router';
import { DomainsPage } from '@/features/ingress/pages/DomainsPage';

export const Route = createFileRoute('/_app/domains')({
  component: DomainsPage,
});
