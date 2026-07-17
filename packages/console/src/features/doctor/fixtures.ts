/**
 * 提案中的 wire 形状:POST /runDoctor 的响应(daemon 内跑 CLI 同一套
 * 只读检查,规则单一来源在 packages/cli/src/doctor.ts)。检查 ID 与真
 * doctor 一比一,不发明假检查(总数以 doctor.ts 跑出来的为准,会随检查
 * 增长)。落地时类型进 shared,本文件只剩删除。
 */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  /** 检查到的事实,一句话。 */
  detail: string;
  /** fail/warn 时点名的修复命令(doctor 只读不代修,修是 install.sh 的活)。 */
  fix?: string;
}

export interface DoctorReport {
  ranAt: string;
  durationMs: number;
  checks: DoctorCheck[];
}

export const SAMPLE_DOCTOR: DoctorReport = {
  ranAt: new Date(Date.now() - 42_000).toISOString(),
  durationMs: 4213,
  checks: [
    {
      id: 'os-linux',
      title: 'Linux x86_64',
      status: 'pass',
      detail: 'Ubuntu 24.04,内核 6.8.0',
    },
    {
      id: 'node-version',
      title: 'Node ≥ 22',
      status: 'pass',
      detail: 'v24.18.0',
    },
    {
      id: 'root',
      title: 'root 权限',
      status: 'pass',
      detail: 'uid 0 — loop 挂载与 cgroup 写入可用',
    },
    {
      id: 'cgroup-v2',
      title: 'cgroup v2 + memory 控制器',
      status: 'pass',
      detail: '冻结要写 memory.reclaim',
    },
    {
      id: 'docker-daemon',
      title: 'Docker daemon 可达',
      status: 'pass',
      detail: 'dockerd 29.6.1 应答正常',
    },
    {
      id: 'gvisor-runtime',
      title: 'runsc 已注册为 Docker runtime',
      status: 'pass',
      detail: 'gVisor release-20260622.0',
    },
    {
      id: 'icc-disabled',
      title: '容器间通信已关(icc: false)',
      status: 'pass',
      detail: '沙箱之间互相不可达',
    },
    {
      id: 'log-rotation',
      title: 'Docker 日志轮转',
      status: 'pass',
      detail: 'json-file,10m × 3',
    },
    {
      id: 'swap',
      title: 'swap 存在',
      status: 'pass',
      detail: '16 GiB /swapfile — 冻结的内存要有地方去',
    },
    {
      id: 'swappiness',
      title: 'vm.swappiness = 100',
      status: 'pass',
      detail:
        '直读 /proc/sys/vm/swappiness 的生效值 — gVisor 的共享内存低于 100 挤不出去',
    },
    {
      id: 'ip-forward',
      title: 'net.ipv4.ip_forward = 1',
      status: 'pass',
      detail: '生效值 1,且 /etc/sysctl.d/99-dormice.conf 在启动序中胜出',
    },
    {
      id: 'metadata-firewall',
      title: '云元数据防火墙',
      status: 'pass',
      detail: 'DOCKER-USER 链 DROP 169.254.0.0/16 与 100.100.100.200',
    },
    {
      id: 'metadata-persisted',
      title: '防火墙规则已持久化',
      status: 'pass',
      detail: 'dormice-metadata-firewall.service 开机在 docker 之后补规则',
    },
    {
      id: 'api-token',
      title: 'DORMICE_API_TOKEN 已配置',
      status: 'pass',
      detail: '存在且非空(不显示内容)',
    },
    {
      id: 's3-config',
      title: 'S3 归档配置',
      status: 'skip',
      detail: 'DORMICE_S3_* 未配置 — 归档器关闭,沙箱永远停在 stopped',
    },
    {
      id: 'zstd',
      title: 'zstd 可用',
      status: 'skip',
      detail: '归档器关闭时不需要 host 侧 tar + zstd',
    },
    {
      id: 'ingress',
      title: '接入层(Caddy)',
      status: 'pass',
      detail: 'caddy v2.10.0 active;未绑定域名(IP 访问)',
    },
    {
      id: 'base-image',
      title: '基础镜像存在',
      status: 'pass',
      detail: 'dormice-base:20260710b 在本机镜像库',
    },
    {
      id: 'absolute-paths',
      title: 'DB/数据目录是绝对路径',
      status: 'pass',
      detail: '相对路径离"空账本撞真沙箱"只差一次走错目录',
    },
    {
      id: 'disk-space',
      title: '数据盘余量',
      status: 'pass',
      detail: '/var/lib/dormice 所在盘剩 162.4 GiB',
    },
    {
      id: 'probe-gvisor',
      title: '探针:假内核',
      status: 'pass',
      detail: '起真 runsc 容器,uname -r = 4.19.0-gvisor(宿主 6.8.0)',
    },
    {
      id: 'probe-metadata',
      title: '探针:元数据被封',
      status: 'pass',
      detail: '沙箱内 curl 169.254.169.254 超时 — BLOCKED',
    },
    {
      id: 'probe-image-user',
      title: '探针:默认身份 uid 1000',
      status: 'pass',
      detail: '沙箱内 id -u = 1000,非 root',
    },
    {
      id: 'probe-image-inotify',
      title: '探针:镜像带 inotify-tools',
      status: 'warn',
      detail: '镜像里没找到 inotifywait — E2B watch 功能会诚实报错',
      fix: '重建基础镜像(images/Dockerfile 已含 inotify-tools),更新 /etc/dormice/env 后重启 daemon',
    },
  ],
};
