import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '@/features/overview/pages/OverviewPage';

export const Route = createFileRoute('/_app/')({
  component: OverviewPage,
});
