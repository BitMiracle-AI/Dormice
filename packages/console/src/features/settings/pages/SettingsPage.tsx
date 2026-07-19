import type { ConfigEntry } from '@dormice/shared';
import { useState } from 'react';
import { DataTable } from '@/components/DataTable';
import { paginate, TablePager } from '@/components/TablePager';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDuration } from '@/features/sandboxes/format';
import { RuntimeSettingsCard } from '../components/RuntimeSettingsCard';
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
  DORMICE_MAX_SANDBOXES: '容量上限的首启种子值 — 生效值在上方运营旋钮里',
  DORMICE_SCAN_INTERVAL_SECONDS: '空闲扫描周期:每一轮把到阈值的沙箱降一格温度',
  DORMICE_METRICS_SAMPLE_INTERVAL_SECONDS:
    '指标采样周期:历史曲线的分辨率,总览走势与指标历史都按它落库',
  DORMICE_METRICS_RETENTION_HOURS:
    '逐沙箱指标样本的保留时长;舰队状态计数恒保 30 天,不随它走',
  DORMICE_SANDBOX_DISK_GB: '默认磁盘配额的首启种子值 — 生效值在上方运营旋钮里',
  DORMICE_SANDBOX_CPUS: '默认 CPU 配额的首启种子值 — 生效值在上方运营旋钮里',
  DORMICE_SANDBOX_MEMORY_GB:
    '默认内存上限的首启种子值 — 生效值在上方运营旋钮里',
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

const PAGE_SIZE = 50;

/**
 * 设置页两段(2026-07-19 用户拍板加运营旋钮):上面是账本里的运营旋钮
 * — 容量上限、新沙箱默认配额、默认策略,updateSettings 网页可改、立即
 * 生效;下面仍是 env 配置的只读观察窗 — 端口、token、executor 这些
 * "身份与地基"改了就是另一台 daemon,真身留在 /etc/dormice/env,改完
 * 重启生效。daemon 从不写自己的环境文件(那是另一个安全等级的决定),
 * 运营旋钮走的是账本:env 同名变量降级为首次启动的种子值。
 */
export function SettingsPage() {
  const { data, isPending, isError, error } = useConfig();
  const [page, setPage] = useState(1);

  if (isPending) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground md:p-6">
        <Spinner /> 读取生效配置
      </div>
    );
  }
  if (isError) {
    return (
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col p-4 md:p-6">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>读取失败</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const { rows, safePage, pageCount } = paginate(data.entries, page, PAGE_SIZE);

  return (
    // openasi 列表页版式(2026-07-16 用户拍板);版本卡已拆去独立的
    // /version 页 — 设置是设置,版本是版本。
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
      <header className="shrink-0">
        <h1 className="text-xl font-medium">设置</h1>
        {/* 这行不是装饰:两类旋钮的界限与 env 的改法只在这里说。 */}
        <p className="mt-1 text-sm text-muted-foreground">
          运营旋钮在下方卡片里直接改;其余配置只读,真身在主机的{' '}
          <code className="font-mono">/etc/dormice/env</code>,改完{' '}
          <code className="font-mono">systemctl restart dormice</code>。归档:
          {data.archive.enabled
            ? `已启用(默认${data.archive.defaultSeconds === null ? '不归档' : `停止后 ${formatDuration(data.archive.defaultSeconds)} 归档`})`
            : '未启用 — 配齐 DORMICE_S3_* 四件套后可用'}
          。
        </p>
      </header>

      <RuntimeSettingsCard data={data} />

      <DataTable fill>
        <TableHeader>
          <TableRow>
            <TableHead>旋钮</TableHead>
            <TableHead>生效值</TableHead>
            <TableHead>来源</TableHead>
            <TableHead>说明</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((entry) => (
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
      </DataTable>

      <TablePager
        page={safePage}
        pageCount={pageCount}
        total={data.entries.length}
        onPageChange={setPage}
      />
    </div>
  );
}
