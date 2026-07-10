import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '@/features/activity/pages/ActivityPage';

export const Route = createFileRoute('/_app/activity')({
  component: ActivityPage,
});
