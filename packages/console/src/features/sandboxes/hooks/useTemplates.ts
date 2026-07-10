import { useQuery } from '@tanstack/react-query';
import { listTemplates } from '@/lib/api';

/**
 * The console only consumes templates (the create form's dropdown, the
 * detail row); registration lives in the CLI (`dor template add`). No
 * polling: templates change at operator speed, a mount-time read is honest
 * enough.
 */
export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: listTemplates,
    retry: false,
  });
}
