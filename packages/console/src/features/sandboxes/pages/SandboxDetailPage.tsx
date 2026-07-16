import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
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
import { UpgradableBadge } from '../components/UpgradableBadge';
import { formatDuration, since } from '../format';
import { useSandbox, useSandboxImages } from '../hooks/useSandboxes';

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
  const { name } = useParams({ from: '/_app/sandboxes/$name' });
  const { tab } = useSearch({ from: '/_app/sandboxes/$name' });
  const navigate = useNavigate({ from: '/sandboxes/$name' });
  const { sandbox, isSuccess } = useSandbox(name);
  // 镜像血统与列表页同一份 5 秒缓存;拿不到就不显示,不挡页面。
  const images = useSandboxImages();
  const lineage = images.data?.images.find((e) => e.sandboxName === name);

  if (!sandbox) {
    return isSuccess ? (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>没有叫「{name}」的沙箱</EmptyTitle>
          <EmptyDescription>
            可能已被销毁 — 这个名字依然可用,下次同名 acquire 会得到一个
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
          <h1 className="font-mono text-2xl font-semibold">{sandbox.name}</h1>
          <SandboxStateBadge state={sandbox.state} />
          <LifecycleCountdown sandbox={sandbox} />
        </div>
        <div className="flex items-center gap-2">
          <EditPolicyDialog sandbox={sandbox} />
          <RebuildSandboxButton name={sandbox.name} />
          <DestroySandboxButton
            name={sandbox.name}
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
                <Row label="沙箱 ID">{sandbox.id}</Row>
                <Row label="模板">
                  <span className="inline-flex items-center gap-1.5">
                    {sandbox.template ?? '基础镜像'}
                    <UpgradableBadge lineage={lineage} />
                  </span>
                </Row>
                {lineage && (
                  <Row label="镜像">
                    {lineage.image === null
                      ? `无容器 — 下次启动用 ${lineage.nextImage}`
                      : lineage.upgradable
                        ? `${lineage.image} → Rebuild 后 ${lineage.nextImage}`
                        : lineage.image}
                  </Row>
                )}
                {Object.keys(sandbox.metadata).length > 0 && (
                  <Row label="标签">
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {Object.entries(sandbox.metadata).map(([key, value]) => (
                        <Badge
                          key={key}
                          variant="outline"
                          className="max-w-[14rem] truncate font-mono text-xs font-normal text-muted-foreground"
                          title={`${key}=${value}`}
                        >
                          {key}={value}
                        </Badge>
                      ))}
                    </span>
                  </Row>
                )}
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
          <SandboxTerminalCard sandboxId={sandbox.id} />
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
          <HistoryPanel name={sandbox.name} />
        </TabsContent>
      </Tabs>
    </>
  );
}
