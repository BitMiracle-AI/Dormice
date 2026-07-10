import { createFileRoute } from '@tanstack/react-router';
import { SandboxesPage } from '@/features/sandboxes/pages/SandboxesPage';

export const Route = createFileRoute('/_app/sandboxes/')({
  component: SandboxesPage,
});
