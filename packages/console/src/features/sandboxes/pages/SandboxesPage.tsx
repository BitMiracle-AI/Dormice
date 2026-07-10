import { PackageIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { logout } from '@/lib/api';
import { clearSessionMarker } from '@/lib/session';
import { CreateSandboxDialog } from '../components/CreateSandboxDialog';
import { ReleaseSandboxButton } from '../components/ReleaseSandboxButton';
import { SandboxStateBadge } from '../components/SandboxStateBadge';
import { policyLine, since } from '../format';
import { useSandboxes } from '../hooks/useSandboxes';

async function signOut() {
  // Best effort: the cookie may already be dead, and that's fine — what
  // matters is clearing the marker and starting over from the login page.
  await logout().catch(() => undefined);
  clearSessionMarker();
  window.location.href = '/console/login';
}

export function SandboxesPage() {
  const query = useSandboxes();
  const sandboxes = query.data?.sandboxes ?? [];

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-6">
      <header className="flex items-center justify-between py-5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">Dormice</h1>
          <span className="text-sm text-muted-foreground">
            {sandboxes.length} sandbox{sandboxes.length === 1 ? '' : 'es'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link to="/connect" />}
          >
            Connect
          </Button>
          <CreateSandboxDialog />
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      {query.isError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}

      {query.isSuccess && sandboxes.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={PackageIcon} />
            </EmptyMedia>
            <EmptyTitle>No sandboxes yet</EmptyTitle>
            <EmptyDescription>
              Create one here, or acquire one via the SDK — it appears within
              two seconds either way.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {sandboxes.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User key</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Idle</TableHead>
                <TableHead>Lifecycle policy</TableHead>
                <TableHead>Age</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sandboxes.map((sandbox) => (
                <TableRow key={sandbox.sandboxId}>
                  <TableCell>
                    <Link
                      to="/sandboxes/$userKey"
                      params={{ userKey: sandbox.userKey }}
                      className="font-mono font-medium hover:underline"
                    >
                      {sandbox.userKey}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <SandboxStateBadge state={sandbox.state} />
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {since(sandbox.lastActiveAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {policyLine(sandbox.policy)}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {since(sandbox.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <ReleaseSandboxButton userKey={sandbox.userKey} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
