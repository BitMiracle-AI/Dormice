import { createFileRoute } from '@tanstack/react-router';
import { NodesPage } from '@/features/nodes/pages/NodesPage';

export const Route = createFileRoute('/_app/nodes/')({
  component: NodesPage,
});
