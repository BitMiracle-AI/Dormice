import { createFileRoute } from '@tanstack/react-router';
import { ConnectPage } from '@/features/connect/pages/ConnectPage';

export const Route = createFileRoute('/_app/connect')({
  component: ConnectPage,
});
