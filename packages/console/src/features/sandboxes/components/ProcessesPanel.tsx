import type { Sandbox } from '@dormice/shared';
import { ListViewIcon, MoreVerticalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { toast } from 'sonner';
import { DataTable } from '@/components/DataTable';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { STATE_LABELS } from '../format';
import { useEnvdAuth, useKillProcess, useProcesses } from '../hooks/useEnvd';

/**
 * daemon 进程表的观察窗:列的是经由 E2B 进程面(SDK 的 background 命令、
 * 在线终端的 bash)启动、还活着的进程。List 在服务端刻意不唤醒 — 冻结的
 * 沙箱进程还在(SIGSTOP 挂起,唤醒续跑),这正是值得看的招牌能力。
 */
export function ProcessesPanel({ sandbox }: { sandbox: Sandbox }) {
  // 只有物理容器在(active/frozen)才有进程表;停机沙箱只剩磁盘。
  const hasContainer = sandbox.state === 'active' || sandbox.state === 'frozen';
  const auth = useEnvdAuth(sandbox.id);
  const processes = useProcesses(auth.data, hasContainer);
  const kill = useKillProcess(auth.data);

  if (!hasContainer) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={ListViewIcon} />
          </EmptyMedia>
          <EmptyTitle>没有进程表</EmptyTitle>
          <EmptyDescription>
            沙箱当前是「{STATE_LABELS[sandbox.state]}」— 只有磁盘还在,
            进程要等下次唤醒才会有。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const list = processes.data ?? [];

  const sendSignal = (
    pid: number,
    signal: 'SIGNAL_SIGTERM' | 'SIGNAL_SIGKILL',
  ) => {
    kill.mutate(
      { pid, signal },
      {
        onSuccess: () =>
          toast.success(
            `已向 ${pid} 发送 ${signal === 'SIGNAL_SIGKILL' ? 'SIGKILL' : 'SIGTERM'}`,
          ),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        经由 E2B 进程面或在线终端启动的存活进程。冻结时进程被整体挂起、 不丢 —
        唤醒后从暂停处继续跑。
      </p>

      {(processes.isError || auth.isError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {processes.error?.message ?? auth.error?.message}
          </AlertDescription>
        </Alert>
      )}

      {processes.isSuccess && list.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={ListViewIcon} />
            </EmptyMedia>
            <EmptyTitle>没有存活的进程</EmptyTitle>
            <EmptyDescription>
              用 SDK 跑一个 background 命令,或在「终端」页开一个 bash,
              它就会出现在这里。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {list.length > 0 && (
        <DataTable>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">PID</TableHead>
              <TableHead>命令</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((process) => (
              <TableRow key={process.pid}>
                <TableCell className="tabular-nums">{process.pid}</TableCell>
                <TableCell className="max-w-md truncate font-mono text-xs">
                  {[process.config.cmd, ...process.config.args].join(' ')}
                </TableCell>
                <TableCell className="text-right">
                  {/* 两个信号收进「⋯」菜单:SIGTERM 是常规请求,
                        SIGKILL 不可拒绝 — 才配 destructive 红。 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`进程 ${process.pid} 的操作`}
                        >
                          <HugeiconsIcon icon={MoreVerticalIcon} />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={kill.isPending}
                        onClick={() =>
                          sendSignal(process.pid, 'SIGNAL_SIGTERM')
                        }
                      >
                        发送 SIGTERM
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={kill.isPending}
                        onClick={() =>
                          sendSignal(process.pid, 'SIGNAL_SIGKILL')
                        }
                      >
                        发送 SIGKILL
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
    </div>
  );
}
