import type { ConfigEntry } from '@dormice/shared';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDuration } from '@/features/sandboxes/format';
import { useConfig } from '../hooks/useConfig';

/**
 * 每个旋钮管什么,一句话 — UI 文案,所以住在前端;wire 上只有键、值、
 * 来源(daemon 不说中文)。没列到的键显示为空,不编造。
 */
const KEY_HINTS: Record<string, string> = {
  DORMICE_PORT: 'daemon 端口;只绑 127.0.0.1,对外暴露是反向代理的活',
  DORMICE_DB_PATH: 'SQLite 账本;docker 模式强制绝对路径',
  DORMICE_NODE_ID: '这台机器在账本里的名字(为将来分片预留)',
  DORMICE_API_TOKEN:
    '唯一的 API 凭证;控制台登录时换成 httpOnly cookie,页面永远读不到它',
  DORMICE_EXECUTOR: '执行器:docker 是真沙箱,fake 是内存假执行器(开发/测试用)',
  DORMICE_BASE_IMAGE: '沙箱的默认镜像;docker 模式必填',
  DORMICE_DATA_DIR: '沙箱磁盘镜像的家(disks/*.img);归档临时文件也在这里',
  DORMICE_MAX_SANDBOXES: '创建上限(撞上回 429);唤醒永不受限 — 磁盘才是真瓶颈',
  DORMICE_SCAN_INTERVAL_SECONDS: '空闲扫描周期:每一轮把到阈值的沙箱降一格温度',
  DORMICE_SANDBOX_DISK_GB: '每个沙箱磁盘的名义大小;稀疏镜像只为真实内容付费',
  DORMICE_SANDBOX_CPUS: '每个沙箱的 CPU 配额',
  DORMICE_SANDBOX_MEMORY_GB:
    '每个沙箱的内存上限;沙箱内 OOM 会让 gVisor 整箱退出(对账救回)',
  DORMICE_SANDBOX_PIDS_LIMIT: '每个沙箱的进程数上限(fork 炸弹的物理闸)',
  DORMICE_RECLAIM_TIMEOUT_SECONDS: '冻结时挤内存进 swap 的最长等待',
  DORMICE_SANDBOX_DOMAIN:
    '端口预览泛域名(getHost);不配则响应里诚实缺席,代理层不启用',
  DORMICE_INGRESS_FILE:
    'daemon 接管的 Caddy 配置文件;配了才能在「域名」页网页绑定域名',
  DORMICE_INGRESS_RELOAD_CMD:
    '改完代理配置后的重载命令;不配默认 caddy reload 托管文件本身',
  DORMICE_S3_ENDPOINT: '归档对象存储的地址;四件套齐了归档才启用',
  DORMICE_S3_BUCKET: '归档桶名',
  DORMICE_S3_ACCESS_KEY_ID: '归档存储的 Access Key(只报已设置)',
  DORMICE_S3_SECRET_ACCESS_KEY: '归档存储的 Secret Key(只报已设置)',
  DORMICE_S3_REGION: 'S3 区域;多数兼容实现随意',
  DORMICE_S3_FORCE_PATH_STYLE: '路径风格寻址:MinIO 要 true,云厂商走子域名',
};

function ValueCell({ entry }: { entry: ConfigEntry }) {
  if (entry.redacted) {
    return <Badge variant="secondary">已设置,不显示</Badge>;
  }
  if (entry.value === null) {
    return <span className="text-muted-foreground">未配置</span>;
  }
  return <>{entry.value}</>;
}

/**
 * daemon 生效配置的只读观察窗:回答"这台 daemon 开了哪些旋钮"。刻意
 * 只读 — 配置的真身在 /etc/dormice/env,改完重启 daemon 生效;网页里
 * 改配置意味着 daemon 要能写自己的配置文件,那是另一个安全等级的决定。
 */
export function SettingsPage() {
  const { data, isPending, isError, error } = useConfig();

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> 读取生效配置
      </div>
    );
  }
  if (isError) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>读取失败</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    // 四列窄表,铺满宽屏一行字拉太长 — 限宽居中,读起来是一页文档。
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">
          daemon 的生效配置,只读。改配置在主机的{' '}
          <code className="font-mono">/etc/dormice/env</code>,改完{' '}
          <code className="font-mono">systemctl restart dormice</code>。归档:
          {data.archive.enabled
            ? `已启用(默认停止后 ${formatDuration(data.archive.defaultSeconds ?? 0)} 归档)`
            : '未启用 — 配齐 DORMICE_S3_* 四件套后可用'}
          。
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
            {data.entries.map((entry) => (
              <TableRow key={entry.key}>
                <TableCell className="font-mono text-xs font-medium">
                  {entry.key}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  <ValueCell entry={entry} />
                </TableCell>
                <TableCell>
                  <Badge
                    variant={entry.source === 'env' ? 'outline' : 'secondary'}
                  >
                    {entry.source === 'env' ? '环境变量' : '默认值'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {KEY_HINTS[entry.key] ?? ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
