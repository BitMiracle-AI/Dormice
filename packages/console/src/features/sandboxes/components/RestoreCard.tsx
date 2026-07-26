import type { Sandbox } from '@dormice/shared';
import { DatabaseRestoreIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { acquireSandbox } from '@/lib/api';
import { m } from '@/paraglide/messages';

/**
 * 归档态的工作台横幅。已归档:磁盘在 S3、本地零占用,给一个显式的
 * 「恢复」动作(就是 acquire — 平台从头到尾只有这一个入口动词)。
 * 恢复中:轮询 acquire 拿真进度 — 协议的承诺就是"acquire 撞 restoring
 * 立即返回进度",对 restoring 行它没有副作用,所以放心每 1.5 秒问一次;
 * 恢复完成后 2 秒轮询的列表会把状态翻回 active,这张卡自然消失。
 */
export function RestoreCard({ sandbox }: { sandbox: Sandbox }) {
  const queryClient = useQueryClient();
  const restoring = sandbox.state === 'restoring';

  const progressQuery = useQuery({
    queryKey: ['restore-progress', sandbox.name],
    queryFn: () => acquireSandbox({ name: sandbox.name }),
    enabled: restoring,
    refetchInterval: 1500,
    retry: false,
  });
  const begin = useMutation({
    mutationFn: () => acquireSandbox({ name: sandbox.name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
    onError: (error) =>
      toast.error(m.sandboxes_restore_failed({ message: error.message })),
  });

  if (restoring) {
    const progress =
      progressQuery.data?.status === 'restoring'
        ? progressQuery.data.progress
        : undefined;
    return (
      <Card size="sm">
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Spinner />
            {m.sandboxes_restoring_status({
              phase:
                progress?.phase === 'extracting'
                  ? m.sandboxes_phase_extracting()
                  : m.sandboxes_phase_downloading(),
            })}
            {progress ? ` ${progress.percent}%` : ''}
          </div>
          <Progress value={progress?.percent ?? 0} />
          <p className="text-xs text-muted-foreground">
            {m.sandboxes_restoring_note()}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <HugeiconsIcon
              icon={DatabaseRestoreIcon}
              className="size-4"
              strokeWidth={1.8}
            />
            {m.sandboxes_archived_headline()}
          </div>
          <p className="text-xs text-muted-foreground">
            {m.sandboxes_archived_desc()}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => begin.mutate()}
          disabled={begin.isPending}
        >
          {begin.isPending && <Spinner />}
          {m.sandboxes_restore()}
        </Button>
      </CardContent>
    </Card>
  );
}
