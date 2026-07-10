import { SampleDataBadge } from '@/components/SampleDataBadge';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
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
import { MOCK_PAGES_ENABLED } from '@/lib/mock';
import { SAMPLE_CONFIG } from '../fixtures';

/**
 * daemon 生效配置的只读观察窗:回答"这台 daemon 开了哪些旋钮"。刻意
 * 只读 — 配置的真身在 /etc/dormice/env,改完重启 daemon 生效;网页里
 * 改配置意味着 daemon 要能写自己的配置文件,那是另一个安全等级的决定。
 */
export function SettingsPage() {
  if (!MOCK_PAGES_ENABLED) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>尚未接入</EmptyTitle>
          <EmptyDescription>
            生效配置视图等 getConfig 端点落地后可用;现在请看主机上的{' '}
            <code className="font-mono">/etc/dormice/env</code>。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          设置 <SampleDataBadge />
        </h1>
        <p className="text-sm text-muted-foreground">
          daemon 的生效配置,只读。改配置在主机的{' '}
          <code className="font-mono">/etc/dormice/env</code>,改完{' '}
          <code className="font-mono">systemctl restart dormice</code>。
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>旋钮</TableHead>
              <TableHead>生效值</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_CONFIG.map((entry) => (
              <TableRow key={entry.key}>
                <TableCell className="font-mono text-xs font-medium">
                  {entry.key}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {entry.redacted ? (
                    <Badge variant="secondary">已设置,不显示</Badge>
                  ) : entry.value === null ? (
                    <span className="text-muted-foreground">未配置</span>
                  ) : (
                    entry.value
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={entry.source === 'env' ? 'outline' : 'secondary'}
                  >
                    {entry.source === 'env' ? '环境变量' : '默认值'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {entry.hint}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
