import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DestroySandboxButton } from '../components/DestroySandboxButton';
import { EditPolicyDialog } from '../components/EditPolicyDialog';
import { FilesPanel } from '../components/FilesPanel';
import { HistoryPanel } from '../components/HistoryPanel';
import { LifecycleCountdown } from '../components/LifecycleCountdown';
import { MetricsPanel } from '../components/MetricsPanel';
import { ProcessesPanel } from '../components/ProcessesPanel';
import { RebuildSandboxButton } from '../components/RebuildSandboxButton';
import { RestoreCard } from '../components/RestoreCard';
import { SandboxStateBadge } from '../components/SandboxStateBadge';
import { SandboxTerminalCard } from '../components/SandboxTerminal';
import { formatDuration, since } from '../format';
import { useSandbox } from '../hooks/useSandboxes';

export const DETAIL_TABS = [
  'overview',
  'terminal',
  'files',
  'processes',
  'metrics',
  'history',
] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b py-3 text-sm last:border-b-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-mono">{children}</dd>
    </div>
  );
}

/**
 * 一个沙箱的工作区。基础信息仍从 2 秒轮询的列表缓存里选(列表是 daemon
 * 唯一的读,不发明第二个端点);文件/进程/终端走 envd 面 — 与官方 e2b
 * SDK 同一条 wire。tab 记在 URL 里,刷新与分享都停在原面板。
 */
export function SandboxDetailPage() {
  const { externalId } = useParams({ from: '/_app/sandboxes/$externalId' });
  const { tab } = useSearch({ from: '/_app/sandboxes/$externalId' });
  const navigate = useNavigate({ from: '/sandboxes/$externalId' });
  const { sandbox, isSuccess } = useSandbox(externalId);

  if (!sandbox) {
    return isSuccess ? (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>没有叫「{externalId}」的沙箱</EmptyTitle>
          <EmptyDescription>
            可能已被销毁 — 这个 key 依然有效,下次 acquire 会得到一个
            全新的沙箱。
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/sandboxes" />}
          >
            回到沙箱列表
          </Button>
        </EmptyContent>
      </Empty>
    ) : null;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-lg font-semibold">
            {sandbox.externalId}
          </h1>
          <SandboxStateBadge state={sandbox.state} />
          <LifecycleCountdown sandbox={sandbox} />
        </div>
        <div className="flex items-center gap-2">
          <EditPolicyDialog sandbox={sandbox} />
          <RebuildSandboxButton externalId={sandbox.externalId} />
          <DestroySandboxButton
            externalId={sandbox.externalId}
            onDestroyed={() => navigate({ to: '/sandboxes' })}
          />
        </div>
      </div>

      {(sandbox.state === 'archived' || sandbox.state === 'restoring') && (
        <RestoreCard sandbox={sandbox} />
      )}

      <Tabs
        value={tab}
        onValueChange={(next) =>
          navigate({
            search: { tab: next as DetailTab },
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="terminal">终端</TabsTrigger>
          <TabsTrigger value="files">文件</TabsTrigger>
          <TabsTrigger value="processes">进程</TabsTrigger>
          <TabsTrigger value="metrics">指标</TabsTrigger>
          <TabsTrigger value="history">历史</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Card>
            <CardContent>
              <dl>
                <Row label="沙箱 ID">{sandbox.sandboxId}</Row>
                <Row label="模板">{sandbox.template ?? '基础镜像'}</Row>
                <Row label="节点">{sandbox.nodeId}</Row>
                <Row label="端点">{sandbox.endpoint}</Row>
                <Row label="创建于">
                  {new Date(sandbox.createdAt).toLocaleString()} ·{' '}
                  {since(sandbox.createdAt)}前
                </Row>
                <Row label="最近活动">{since(sandbox.lastActiveAt)}前</Row>
                <Row label="冻结阈值">
                  空闲 {formatDuration(sandbox.policy.freezeAfterSeconds)}
                </Row>
                <Row label="停止阈值">
                  {sandbox.policy.stopAfterSeconds === null
                    ? '永不(常驻 agent)'
                    : `空闲 ${formatDuration(sandbox.policy.stopAfterSeconds)}`}
                </Row>
                <Row label="归档阈值">
                  {sandbox.policy.archiveAfterSeconds === null
                    ? '永不'
                    : `空闲 ${formatDuration(sandbox.policy.archiveAfterSeconds)}`}
                </Row>
              </dl>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="terminal">
          <SandboxTerminalCard sandboxId={sandbox.sandboxId} />
        </TabsContent>

        <TabsContent value="files">
          <FilesPanel sandbox={sandbox} />
        </TabsContent>

        <TabsContent value="processes">
          <ProcessesPanel sandbox={sandbox} />
        </TabsContent>

        <TabsContent value="metrics">
          <MetricsPanel sandbox={sandbox} />
        </TabsContent>

        <TabsContent value="history">
          <HistoryPanel externalId={sandbox.externalId} />
        </TabsContent>
      </Tabs>
    </>
  );
}
