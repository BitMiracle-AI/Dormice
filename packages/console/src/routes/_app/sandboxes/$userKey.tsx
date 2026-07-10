import { createFileRoute } from '@tanstack/react-router';
import { SandboxDetailPage } from '@/features/sandboxes/pages/SandboxDetailPage';

export const Route = createFileRoute('/_app/sandboxes/$userKey')({
  component: SandboxDetailPage,
});
