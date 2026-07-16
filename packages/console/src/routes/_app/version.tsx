import { createFileRoute } from '@tanstack/react-router';
import { VersionPage } from '@/features/settings/pages/VersionPage';

export const Route = createFileRoute('/_app/version')({
  component: VersionPage,
});
