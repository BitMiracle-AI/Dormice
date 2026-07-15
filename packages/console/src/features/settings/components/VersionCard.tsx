import type { CheckUpgradeResponse } from '@dormice/shared';
import { RefreshIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useCheckUpgrade, useForceCheckUpgrade } from '../hooks/useUpgrade';

/**
 * daemon 自己的版本与升级窗口。「版本」= 构建进 dist 的 git commit
 * (还没有发版 tag,main 上每个提交都过验收链);比较由 daemon 服务端
 * 裁决(upgradable 字段),这里只负责显示 — 与沙箱「可升级」徽章同一
 * 纪律。检查失败如实显示 checkError,绝不把失败装成「已是最新」。
 */
export function VersionCard() {
  const { data, isPending, isError, error } = useCheckUpgrade();
  const force = useForceCheckUpgrade();

  return (
    <Card>
      <CardHeader>
        <CardTitle>版本</CardTitle>
        <CardDescription>
          daemon 当前运行的构建,以及远端 main 上有没有更新的版本
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending || force.isPending}
            onClick={() => force.mutate()}
          >
            {force.isPending ? (
              <Spinner />
            ) : (
              <HugeiconsIcon icon={RefreshIcon} />
            )}
            检查更新
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> 检查版本
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">检查失败:{error.message}</p>
        ) : (
          <VersionBody data={data} />
        )}
      </CardContent>
    </Card>
  );
}

function VersionBody({ data }: { data: CheckUpgradeResponse }) {
  const { current, check, checkError } = data;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="text-muted-foreground">当前版本</span>
        {current ? (
          <>
            <code className="font-mono font-medium">{current.commit}</code>
            <span
              className="min-w-0 truncate text-muted-foreground"
              title={new Date(current.committedAt).toLocaleString()}
            >
              {current.title}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            未知 — 此构建不在 git 检出里完成,没有版本身份
          </span>
        )}
      </div>

      {checkError !== null && (
        <p className="text-sm text-destructive">无法检查更新:{checkError}</p>
      )}

      {check &&
        (check.upgradable ? (
          <UpgradePreview check={check} />
        ) : check.aheadBy > 0 ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            本地比远端 main 多 {check.aheadBy} 个提交(代码有分叉)
            ,升级前先处理本地改动 — install.sh 只接受快进更新。
          </p>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            title={new Date(check.checkedAt).toLocaleString()}
          >
            已是最新{check.cached ? '(缓存结果,点「检查更新」重测)' : ''}
          </p>
        ))}
    </>
  );
}

function UpgradePreview({
  check,
}: {
  check: NonNullable<CheckUpgradeResponse['check']>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <Badge
          variant="outline"
          className="border-amber-500/40 bg-amber-500/10 font-medium text-amber-600 dark:text-amber-400"
        >
          可升级
        </Badge>
        <span>
          落后 {check.behindBy} 个提交,最新{' '}
          <code className="font-mono">{check.latest.commit}</code>
        </span>
      </div>
      <ul className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
        {check.commits.map((entry) => (
          <li key={entry.commit} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">
              {entry.commit}
            </span>
            <span className="min-w-0 truncate" title={entry.title}>
              {entry.title}
            </span>
          </li>
        ))}
        {check.behindBy > check.commits.length && (
          <li className="text-muted-foreground">
            还有 {check.behindBy - check.commits.length} 个更早的提交未列出
          </li>
        )}
      </ul>
      <p className="text-sm text-muted-foreground">
        升级方式:在服务器上重跑 install.sh(重跑即升级,不轮换 API token)。
      </p>
    </div>
  );
}
