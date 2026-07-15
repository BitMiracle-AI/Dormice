import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysPage } from '@/features/api-keys/pages/ApiKeysPage';

export const Route = createFileRoute('/_app/api-keys')({
  component: ApiKeysPage,
});
