import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useIsMobile } from '@/hooks/use-mobile';
import { DestroySandboxButton } from '../components/DestroySandboxButton';
import { EditPolicyDialog } from '../components/EditPolicyDialog';
import { LifecycleCountdown } from '../components/LifecycleCountdown';
import { RebuildSandboxButton } from '../components/RebuildSandboxButton';
import { RestoreCard } from '../components/RestoreCard';
import { SandboxStateBadge } from '../components/SandboxStateBadge';
import { FilePreviewPane } from '../components/workbench/FilePreviewPane';
import { FileTreePane } from '../components/workbench/FileTreePane';
import { MonitorRail } from '../components/workbench/MonitorRail';
import { TerminalPane } from '../components/workbench/TerminalPane';
import type { EnvdEntry } from '../envd-client';
import { useSandbox } from '../hooks/useSandboxes';

/**
 * 一个沙箱的工作台(2026-07-18 monitor 方案拍板,取代六 tab):左文件树、
 * 中间预览+终端竖分、右监视栏常驻 — "真电脑"的样子,观察面不再藏进
 * tab。基础信息仍从 2 秒轮询的列表缓存里选(列表是 daemon 唯一的读,
 * 不发明第二个端点);文件/进程/终端走 envd 面 — 与官方 e2b SDK 同一条
 * wire。
 *
 * 两条纪律撑起整个版式:
 * - 看不解冻:右栏全是只读观察(指标/进程/活动服务端刻意不 wake),
 *   常驻无害;文件树与终端各自把第一次使用挡在显式点击后面 — 没有
 *   中央闸门,每个窗格自己裁决(单一裁决点)。
 * - 工作台全宽 + 锁视口:列表页是"读",限宽利于扫读;工作台是"干活",
 *   宽度即生产力(RULES/前端.md 容器宽度的拍板例外)。窄屏(<768px)
 *   退化为普通纵向滚动流,可拖分栏在触屏上本来就不成立。
 */
export function SandboxDetailPage() {
  const { name } = useParams({ from: '/_app/sandboxes/$name' });
  const navigate = useNavigate({ from: '/sandboxes/$name' });
  const { sandbox, isSuccess } = useSandbox(name);
  const [selected, setSelected] = useState<EnvdEntry | null>(null);
  const isMobile = useIsMobile();

  if (!sandbox) {
    return isSuccess ? (
      <Empty className="m-4 border border-dashed md:m-6">
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

  const header = (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-xl font-medium">{sandbox.name}</h1>
        <SandboxStateBadge state={sandbox.state} />
        <LifecycleCountdown sandbox={sandbox} />
      </div>
      <div className="flex items-center gap-2">
        <EditPolicyDialog sandboxes={[sandbox]} />
        <RebuildSandboxButton name={sandbox.name} />
        <DestroySandboxButton
          name={sandbox.name}
          onDestroyed={() => navigate({ to: '/sandboxes' })}
        />
      </div>
    </header>
  );

  const restore = (sandbox.state === 'archived' ||
    sandbox.state === 'restoring') && <RestoreCard sandbox={sandbox} />;

  if (isMobile) {
    // 窄屏:普通纵向滚动流,窗格装进定高框(它们全是 h-full flex-col,
    // 装进什么高度都成立),右栏卡片自然流淌。
    return (
      // key=id:同名沙箱销毁重建是新的一世,选中/解锁等窗格状态全部重置。
      <div key={sandbox.id} className="flex w-full flex-col gap-3 p-4">
        {header}
        {restore}
        <div className="h-[40vh] overflow-hidden rounded-xl border bg-card">
          <FileTreePane
            sandbox={sandbox}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
        <div className="h-[50vh] overflow-hidden rounded-xl border bg-card">
          <FilePreviewPane
            sandbox={sandbox}
            selected={selected}
            onClear={() => setSelected(null)}
          />
        </div>
        <div className="h-[50vh] overflow-hidden rounded-xl border bg-card">
          <TerminalPane sandbox={sandbox} />
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <MonitorRail sandbox={sandbox} />
        </div>
      </div>
    );
  }

  return (
    <div
      key={sandbox.id}
      className="flex h-full min-h-0 w-full flex-col gap-3 p-4"
    >
      {header}
      {restore}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card"
      >
        <ResizablePanel defaultSize={17} minSize={12}>
          <FileTreePane
            sandbox={sandbox}
            selected={selected}
            onSelect={setSelected}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={56} minSize={30}>
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel defaultSize={56} minSize={20}>
              <FilePreviewPane
                sandbox={sandbox}
                selected={selected}
                onClear={() => setSelected(null)}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={44} minSize={20}>
              <TerminalPane sandbox={sandbox} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={27} minSize={20}>
          <MonitorRail sandbox={sandbox} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
