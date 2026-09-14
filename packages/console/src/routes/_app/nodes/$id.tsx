import { createFileRoute } from '@tanstack/react-router';
import { NodeDetailPage } from '@/features/nodes/pages/NodeDetailPage';

export const Route = createFileRoute('/_app/nodes/$id')({
  component: NodeDetailPage,
});
