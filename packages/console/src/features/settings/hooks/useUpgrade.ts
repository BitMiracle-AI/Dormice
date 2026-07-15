import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checkUpgrade, getUpgradeStatus } from '@/lib/api';

/**
 * 版本检查只在打开设置页与点按钮时发生 — 刻意不做后台轮询(检查会打
 * 远端仓库,后台跑等于 phone home);daemon 侧另有一小时缓存,反复进
 * 页面不重复走网络。检查失败是数据(checkError)不是异常,卡片如实显示。
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
 * 报告。全是本机读数(systemctl + 状态文件),不打网络 — 版本卡拿它
 * 决定「升级」按钮还是手动指引。升级弹窗里的 2 秒轮询是弹窗自己的
 * setTimeout 链(daemon 重启的失联是预期环节,查询库的重试语义不合身);
 * 这里只在有升级在跑时自轮询 — 横幅与「上次运行」的结局要能自愈,
 * 不能指望弹窗一直开着。
 */
export function useUpgradeStatus() {
  return useQuery({
    queryKey: ['upgradeStatus'],
    queryFn: getUpgradeStatus,
    staleTime: 15_000,
    retry: false,
    refetchInterval: (query) => (query.state.data?.running ? 5000 : false),
  });
}

/**
 * 侧栏角标的只读缓存视图:绝不自己发请求(检查只在设置页与按钮发生,
 * 角标不该成为第二个 phone-home 入口),设置页查过且可升级才亮。
 */
export function useCachedUpgradable(): boolean {
  const { data } = useQuery({
    queryKey: ['checkUpgrade'],
    queryFn: () => checkUpgrade(),
    enabled: false,
  });
  return data?.check?.upgradable ?? false;
}
