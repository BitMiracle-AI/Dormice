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
import { m } from '@/paraglide/messages';
import { ArchiveStoreCard } from '../components/ArchiveStoreCard';
import { RuntimeSettingsCard } from '../components/RuntimeSettingsCard';
import { useConfig } from '../hooks/useConfig';

/**
 * 每个旋钮管什么,一句话 — UI 文案,所以住在前端;wire 上只有键、值、
 * 来源(网关不说中文)。2026-09-14 起 getConfig 是网关的:这里列的是网关
 * 的环境变量 — 它自己的端口/库/落位闸,加舰队设置的首启种子;节点的端
 * 口、执行器、数据盘等不在这张表上(它们是节点机器的事)。没列到的键显示
 * 为空,不编造。
 */
const KEY_HINTS: Record<string, () => string> = {
  DORMICE_GATEWAY_PORT: m.settings_hint_gateway_port,
  DORMICE_GATEWAY_DB_PATH: m.settings_hint_gateway_db_path,
  DORMICE_API_TOKEN: m.settings_hint_api_token,
  DORMICE_GATEWAY_NODE_CPU_LIMIT_PCT: m.settings_hint_node_cpu_limit,
  DORMICE_GATEWAY_NODE_ACTIVE_LIMIT: m.settings_hint_node_active_limit,
  DORMICE_GATEWAY_NODE_MIN_DISK_GB: m.settings_hint_node_min_disk,
  DORMICE_GATEWAY_SAMPLE_INTERVAL_SECONDS: m.settings_hint_sample_interval,
  DORMICE_SANDBOX_DISK_GB: m.settings_hint_sandbox_disk,
  DORMICE_SANDBOX_CPUS: m.settings_hint_sandbox_cpus,
  DORMICE_SANDBOX_MEMORY_GB: m.settings_hint_sandbox_memory,
  DORMICE_SANDBOX_PIDS_LIMIT: m.settings_hint_sandbox_pids_limit,
  DORMICE_SANDBOX_DOMAIN: m.settings_hint_sandbox_domain,
  DORMICE_INGRESS_FILE: m.settings_hint_ingress_file,
  DORMICE_INGRESS_RELOAD_CMD: m.settings_hint_ingress_reload_cmd,
  DORMICE_S3_ENDPOINT: m.settings_hint_s3_endpoint,
  DORMICE_S3_BUCKET: m.settings_hint_s3_bucket,
  DORMICE_S3_ACCESS_KEY_ID: m.settings_hint_s3_access_key,
  DORMICE_S3_SECRET_ACCESS_KEY: m.settings_hint_s3_secret_key,
  DORMICE_S3_REGION: m.settings_hint_s3_region,
  DORMICE_S3_FORCE_PATH_STYLE: m.settings_hint_s3_force_path_style,
};

function ValueCell({ entry }: { entry: ConfigEntry }) {
  if (entry.redacted) {
    return <Badge variant="secondary">{m.settings_value_redacted()}</Badge>;
  }
  if (entry.value === null) {
    return (
      <span className="text-muted-foreground">{m.settings_value_unset()}</span>
    );
  }
  return <>{entry.value}</>;
}

const PAGE_SIZE = 50;

/**
 * 设置页两段(2026-07-19 用户拍板加运营旋钮):上面是账本里的运营旋钮
 * — 容量上限、新沙箱默认配额、默认策略,updateSettings 网页可改、立即
 * 生效;下面仍是 env 配置的只读观察窗 — 端口、token、executor 这些
 * "身份与地基"改了就是另一台网关,真身留在 /etc/dormice/gateway.env,改完
 * 重启生效。网关从不写自己的环境文件(那是另一个安全等级的决定),运营
 * 旋钮走的是网关的设置表,节点在下一次报到时接手:env 同名变量降级为网关
 * 首次启动的种子值(2026-09-14 配置权威搬到网关)。
 */
export function SettingsPage() {
  const { data, isPending, isError, error } = useConfig();
  const [page, setPage] = useState(1);

  if (isPending) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground md:p-6">
        <Spinner /> {m.settings_loading_config()}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col p-4 md:p-6">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{m.settings_load_failed()}</EmptyTitle>
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
        <h1 className="text-xl font-medium">{m.settings_page_title()}</h1>
        {/* 这行不是装饰:两类旋钮的界限与 env 的改法只在这里说。 */}
        <p className="mt-1 text-sm text-muted-foreground">
          {m.settings_env_note_1()}{' '}
          <code className="font-mono">/etc/dormice/gateway.env</code>
          {m.settings_env_note_2()}{' '}
          <code className="font-mono">systemctl restart dormice-gateway</code>
          {m.settings_env_note_archive()}
          {data.archive.enabled
            ? m.settings_archive_enabled({
                policy:
                  data.archive.defaultSeconds === null
                    ? m.settings_archive_default_none()
                    : m.settings_archive_default_after({
                        duration: formatDuration(data.archive.defaultSeconds),
                      }),
              })
            : m.settings_archive_disabled()}
        </p>
      </header>

      <RuntimeSettingsCard data={data} />

      <ArchiveStoreCard data={data} />

      <DataTable fill>
        <TableHeader>
          <TableRow>
            <TableHead>{m.settings_col_key()}</TableHead>
            <TableHead>{m.settings_col_value()}</TableHead>
            <TableHead>{m.settings_col_source()}</TableHead>
            <TableHead>{m.settings_col_hint()}</TableHead>
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
                  {entry.source === 'env'
                    ? m.settings_source_env()
                    : m.settings_source_default()}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {KEY_HINTS[entry.key]?.() ?? ''}
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
