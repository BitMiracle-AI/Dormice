import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { RebuildSandboxButton } from '../components/RebuildSandboxButton';
import { ReleaseSandboxButton } from '../components/ReleaseSandboxButton';
import { SandboxStateBadge } from '../components/SandboxStateBadge';
import { SandboxTerminalCard } from '../components/SandboxTerminal';
import { formatDuration, since } from '../format';
import { useSandbox } from '../hooks/useSandboxes';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b py-3 text-sm last:border-b-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-mono">{children}</dd>
    </div>
  );
}

/**
 * Everything /listSandboxes knows about one key. The list is the only read
 * the daemon offers, so this page selects from the same 2s-polled cache —
 * no second endpoint, no second truth.
 */
export function SandboxDetailPage() {
  const { userKey } = useParams({ from: '/_app/sandboxes/$userKey' });
  const navigate = useNavigate();
  const { sandbox, isSuccess } = useSandbox(userKey);

  if (!sandbox) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-10">
        {isSuccess && (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyTitle>No sandbox for “{userKey}”</EmptyTitle>
              <EmptyDescription>
                It may have been released — the key is free to acquire again.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" render={<Link to="/" />}>
                Back to sandboxes
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-6">
      <header className="flex items-center justify-between py-5">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            render={<Link to="/" aria-label="Back to sandboxes" />}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} />
          </Button>
          <h1 className="font-mono text-lg font-semibold">{sandbox.userKey}</h1>
          <SandboxStateBadge state={sandbox.state} />
        </div>
        <div className="flex items-center gap-2">
          <RebuildSandboxButton userKey={sandbox.userKey} />
          <ReleaseSandboxButton
            userKey={sandbox.userKey}
            onReleased={() => navigate({ to: '/' })}
          />
        </div>
      </header>

      <div className="mb-6">
        <SandboxTerminalCard sandboxId={sandbox.sandboxId} />
      </div>

      <Card>
        <CardContent>
          <dl>
            <Row label="Sandbox ID">{sandbox.sandboxId}</Row>
            <Row label="Template">{sandbox.template ?? 'base image'}</Row>
            <Row label="Node">{sandbox.nodeId}</Row>
            <Row label="Endpoint">{sandbox.endpoint}</Row>
            <Row label="Created">
              {new Date(sandbox.createdAt).toLocaleString()} ·{' '}
              {since(sandbox.createdAt)} ago
            </Row>
            <Row label="Last active">{since(sandbox.lastActiveAt)} ago</Row>
            <Row label="Freeze after">
              {formatDuration(sandbox.policy.freezeAfterSeconds)} idle
            </Row>
            <Row label="Stop after">
              {sandbox.policy.stopAfterSeconds === null
                ? 'never (resident agent)'
                : `${formatDuration(sandbox.policy.stopAfterSeconds)} idle`}
            </Row>
            <Row label="Archive after">
              {sandbox.policy.archiveAfterSeconds === null
                ? 'never'
                : `${formatDuration(sandbox.policy.archiveAfterSeconds)} idle`}
            </Row>
          </dl>
        </CardContent>
      </Card>
    </main>
  );
}
