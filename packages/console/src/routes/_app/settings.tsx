import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/features/settings/pages/SettingsPage';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsPage,
});
