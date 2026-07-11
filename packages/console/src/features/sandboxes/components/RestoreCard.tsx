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
    queryKey: ['restore-progress', sandbox.userKey],
    queryFn: () => acquireSandbox({ userKey: sandbox.userKey }),
    enabled: restoring,
    refetchInterval: 1500,
    retry: false,
  });
  const begin = useMutation({
    mutationFn: () => acquireSandbox({ userKey: sandbox.userKey }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
    onError: (error) => toast.error(`恢复没能开始:${error.message}`),
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
            正在从 S3 恢复 —{' '}
            {progress?.phase === 'extracting' ? '解压到新盘' : '下载归档'}
            {progress ? ` ${progress.percent}%` : ''}
          </div>
          <Progress value={progress?.percent ?? 0} />
          <p className="text-xs text-muted-foreground">
            恢复完成后自动回到「运行中」;期间释放会被拒绝(409),等它跑完。
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
            已归档:磁盘压缩存放在 S3,本地零占用
          </div>
          <p className="text-xs text-muted-foreground">
            恢复 = 下载归档并解压到一块新盘,再按模板当前镜像重建容器 —
            也就是恢复即升级。终端/文件要等恢复完成后才可用。
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => begin.mutate()}
          disabled={begin.isPending}
        >
          {begin.isPending && <Spinner />}
          恢复
        </Button>
      </CardContent>
    </Card>
  );
}
