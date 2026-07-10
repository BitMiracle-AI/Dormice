import { createFileRoute } from '@tanstack/react-router';
import { DoctorPage } from '@/features/doctor/pages/DoctorPage';

export const Route = createFileRoute('/_app/doctor')({
  component: DoctorPage,
});
