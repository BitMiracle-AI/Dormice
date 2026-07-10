/**
 * 提案中的 wire 形状:POST /listActivity 的响应行。事件将来自账本状态
 * 迁移处的单点埋点(transition/对账/扫描器),存 SQLite 有界环形表
 * (最近 N 条,溢出丢最老)— 是账本的历史,不是监控系统。落地时这些
 * 类型进 @dormice/shared,本文件只剩删除。
 */
export type ActivityKind =
  | 'created'
  | 'woken'
  | 'frozen'
  | 'stopped'
  | 'rebuilt'
  | 'released'
  | 'reconciled'
  | 'expired-killed';

export interface ActivityEvent {
  id: string;
  at: string;
  kind: ActivityKind;
  userKey: string | null;
  /** 一句话补充:谁干的、为什么、修了什么。 */
  detail: string;
}

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  created: '创建',
  woken: '唤醒',
  frozen: '冻结',
  stopped: '停止',
  rebuilt: '重建',
  released: '释放',
  reconciled: '对账修复',
  'expired-killed': '到期销毁',
};

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

export const SAMPLE_ACTIVITY: ActivityEvent[] = [
  {
    id: 'evt-01',
    at: minutesAgo(1),
    kind: 'frozen',
    userKey: 'web-scraper',
    detail: '空闲 5 分钟到阈值,内存挤入 swap(扫描器)',
  },
  {
    id: 'evt-02',
    at: minutesAgo(3),
    kind: 'woken',
    userKey: 'demo-agent',
    detail: 'execCommand 触达,~50ms 从 frozen 恢复',
  },
  {
    id: 'evt-03',
    at: minutesAgo(12),
    kind: 'created',
    userKey: 'demo-agent',
    detail: 'acquire 新建,模板 python-ml,策略 冻结 10分钟 · 停止 永不',
  },
  {
    id: 'evt-04',
    at: minutesAgo(25),
    kind: 'rebuilt',
    userKey: 'build-runner',
    detail: '换壳保盘:下次唤醒用 daemon 当前基础镜像',
  },
  {
    id: 'evt-05',
    at: minutesAgo(41),
    kind: 'stopped',
    userKey: 'docs-writer',
    detail: '空闲 30 分钟到阈值,容器拆除、磁盘保留(扫描器)',
  },
  {
    id: 'evt-06',
    at: minutesAgo(58),
    kind: 'reconciled',
    userKey: 'email-triage',
    detail: '容器消失但磁盘还在(疑似 docker prune),账本改记 stopped',
  },
  {
    id: 'evt-07',
    at: minutesAgo(95),
    kind: 'expired-killed',
    userKey: 'ci-check-4821',
    detail: 'E2B deadline(kill 型)到点,连盘一起销毁',
  },
  {
    id: 'evt-08',
    at: minutesAgo(130),
    kind: 'released',
    userKey: 'scratch-1',
    detail: 'releaseSandbox:先拆容器再删账本行',
  },
  {
    id: 'evt-09',
    at: minutesAgo(178),
    kind: 'created',
    userKey: 'web-scraper',
    detail: 'acquire 新建,基础镜像,默认策略',
  },
  {
    id: 'evt-10',
    at: minutesAgo(240),
    kind: 'woken',
    userKey: 'build-runner',
    detail: '同 key acquire 从 stopped 冷启动重建(盘是本体)',
  },
];
