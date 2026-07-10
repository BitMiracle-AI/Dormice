/**
 * 提案中的 wire 形状:POST /getConfig 的响应行 — daemon 生效配置的只读
 * 快照(查生效值,与 doctor 同一条纪律)。敏感值只报"已设置",绝不回传
 * 内容。落地时类型进 shared,本文件只剩删除。
 */
export interface ConfigEntry {
  key: string;
  /** 生效值;敏感项为 null,配 redacted: true。 */
  value: string | null;
  /** 值从哪来:环境变量显式给的,还是代码里的默认值。 */
  source: 'env' | 'default';
  redacted?: boolean;
  /** 这个旋钮管什么,一句话。 */
  hint: string;
}

export const SAMPLE_CONFIG: ConfigEntry[] = [
  {
    key: 'DORMICE_API_TOKEN',
    value: null,
    source: 'env',
    redacted: true,
    hint: '唯一的 API 凭证;控制台登录时换成 httpOnly cookie,页面永远读不到它',
  },
  {
    key: 'DORMICE_EXECUTOR',
    value: 'docker',
    source: 'env',
    hint: '执行器:docker 是真沙箱,fake 是内存假执行器(开发/测试用)',
  },
  {
    key: 'DORMICE_BASE_IMAGE',
    value: 'dormice-base:20260710b',
    source: 'env',
    hint: '沙箱的默认镜像;docker 模式必填,启动即校验存在',
  },
  {
    key: 'DORMICE_DB_PATH',
    value: '/var/lib/dormice/dormice.db',
    source: 'env',
    hint: 'SQLite 账本;docker 模式强制绝对路径',
  },
  {
    key: 'DORMICE_DATA_DIR',
    value: '/var/lib/dormice',
    source: 'env',
    hint: '沙箱磁盘镜像的家(disks/*.img)',
  },
  {
    key: 'DORMICE_PORT',
    value: '3676',
    source: 'default',
    hint: 'daemon 端口;只绑 127.0.0.1,对外暴露是反向代理的活',
  },
  {
    key: 'DORMICE_MAX_SANDBOXES',
    value: '100',
    source: 'default',
    hint: '创建上限(撞上回 429);唤醒永不受限 — 磁盘才是真瓶颈',
  },
  {
    key: 'DORMICE_SCAN_INTERVAL_SECONDS',
    value: '60',
    source: 'default',
    hint: '空闲扫描周期:每一轮把到阈值的沙箱降一格温度',
  },
  {
    key: 'DORMICE_SANDBOX_MEMORY_GB',
    value: '2',
    source: 'default',
    hint: '每个沙箱的内存上限;沙箱内 OOM 会让 gVisor 整箱退出(对账救回)',
  },
  {
    key: 'DORMICE_SANDBOX_DOMAIN',
    value: null,
    source: 'default',
    hint: '端口预览域名(getHost);不配则响应里诚实缺席,代理层不启用',
  },
];
