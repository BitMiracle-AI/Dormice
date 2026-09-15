import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checkUpgrade, getUpgradeStatus } from '@/lib/api';

/**
 * 版本检查只在"人到场"时发生 — 开台一次(AppShell 挂 UpgradeNotice,
 * 2026-07-18 起)、打开版本页、点按钮;刻意不做定时轮询(检查会打远端
 * 仓库,无人时后台跑才是 phone home,管理员主动打开控制台不算);
 * daemon 侧另有一小时缓存,反复进页面不重复走网络。检查失败是数据
 * (checkError)不是异常,卡片如实显示。
 */
export function useCheckUpgrade() {
  return useQuery({
    queryKey: ['checkUpgrade'],
    queryFn: () => checkUpgrade(),
    staleTime: 3600_000,
    retry: false,
  });
}

/** 「检查更新」按钮:force 穿透 daemon 缓存,结果写回同一份查询缓存。 */
export function useForceCheckUpgrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => checkUpgrade(true),
    onSuccess: (data) => queryClient.setQueryData(['checkUpgrade'], data),
  });
}

/**
 * 升级执行窗:一键升级可不可用、systemd unit 是否活着、上一次运行的
 * 报告,以及(2026-09-15 刀 4 起)各节点对着网关构建的站位。网关机
 * 本机读数(systemctl + 状态文件)加报到里的内存,不打网络 — 版本卡
 * 拿它决定「升级」按钮还是手动指引,并画节点表。升级弹窗里的 2 秒
 * 轮询是弹窗自己的 setTimeout 链(网关重启的失联是预期环节,查询库
 * 的重试语义不合身);这里在有升级在跑、或有节点待升/升级中时自轮询
 * — 横幅、「上次运行」的结局与节点表的滚动都要能自愈,不能指望弹窗
 * 一直开着。
 */
export function useUpgradeStatus() {
  return useQuery({
    queryKey: ['upgradeStatus'],
    queryFn: getUpgradeStatus,
    staleTime: 15_000,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      const rolling = data.nodes?.some(
        (n) => n.state === 'behind' || n.state === 'upgrading',
      );
      return data.running || rolling ? 5000 : false;
    },
  });
}

/**
 * 侧栏角标的只读缓存视图:绝不自己发请求(开台与版本页已是仅有的
 * 检查入口,角标不该成为第三个),查过且可升级才亮。开台检查落进
 * 同一份缓存,所以角标从登录起就能亮;忽略提醒弹窗不熄灭它 —
 * 被动信号不打扰人,也不撒谎。
 */
export function useCachedUpgradable(): boolean {
  const { data } = useQuery({
    queryKey: ['checkUpgrade'],
    queryFn: () => checkUpgrade(),
    enabled: false,
  });
  return data?.check?.upgradable ?? false;
}
