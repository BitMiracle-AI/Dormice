import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { mintEnvdToken } from '@/lib/api';
import {
  createWatcher,
  downloadFile,
  type EnvdAuth,
  getWatcherEvents,
  killProcess,
  listDir,
  listProcesses,
  makeDir,
  moveEntry,
  removeEntry,
  removeWatcher,
  uploadFile,
} from '../envd-client';

/**
 * 一个沙箱的 envd 面数据层:token、文件、进程。token 是无状态 HMAC,
 * 不过期 — 铸一次缓存整个会话(轮换 API token 才作废,那时 401 拦截兜底)。
 */
export function useEnvdAuth(sandboxId: string) {
  return useQuery({
    queryKey: ['envdToken', sandboxId],
    queryFn: async (): Promise<EnvdAuth> => {
      const { envdAccessToken } = await mintEnvdToken(sandboxId);
      return { sandboxId, envdAccessToken };
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * 目录列表。enabled 由调用方裁决:文件动词会唤醒冻结沙箱,所以第一次
 * 浏览必须站在一次显式点击后面(与终端同一条纪律)。
 */
export function useDirectory(
  auth: EnvdAuth | undefined,
  path: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['envdDir', auth?.sandboxId, path],
    queryFn: () => {
      if (!auth) throw new Error('缺少 envd 凭证');
      return listDir(auth, path);
    },
    enabled: enabled && auth !== undefined,
    retry: false,
  });
}

/** 文件动词的 mutation 家族,成功后重扫当前目录。 */
export function useFileMutations(auth: EnvdAuth | undefined) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    if (auth) {
      void queryClient.invalidateQueries({
        queryKey: ['envdDir', auth.sandboxId],
      });
    }
  };
  const requireAuth = (): EnvdAuth => {
    if (!auth) throw new Error('缺少 envd 凭证');
    return auth;
  };

  const mkdir = useMutation({
    mutationFn: (path: string) => makeDir(requireAuth(), path),
    onSuccess: invalidate,
  });
  const move = useMutation({
    mutationFn: (args: { source: string; destination: string }) =>
      moveEntry(requireAuth(), args.source, args.destination),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (path: string) => removeEntry(requireAuth(), path),
    onSuccess: invalidate,
  });
  const upload = useMutation({
    mutationFn: (args: { path: string; file: File }) =>
      uploadFile(requireAuth(), args.path, args.file),
    onSuccess: invalidate,
  });
  const download = useMutation({
    mutationFn: async (args: { path: string; name: string }) => {
      const blob = await downloadFile(requireAuth(), args.path);
      // 浏览器侧落盘:临时 object URL + 隐形 <a download>。
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = args.name;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  });

  return { mkdir, move, remove, upload, download };
}

/**
 * 当前目录的实时刷新:envd 的轮询三动词(CreateWatcher → GetWatcherEvents
 * → RemoveWatcher),沙箱里(agent、终端)动了文件,面板 2 秒内自己跟上。
 *
 * 唤醒纪律是这个 hook 的全部难点:GetWatcherEvents 不唤醒(读 daemon
 * 内存,冻结沙箱的盘也不会变),可以放心轮询;但 Create/Remove 都要容器
 * 活着(容器里有个 inotifywait 要起/停)— 所以**只在沙箱 active 时武装
 * 或拆除**。沙箱睡了就让监听器随容器一起消亡(404 是预期收场),等它下
 * 次因真实使用而醒来再重新武装;绝不为"接着看"或"收拾干净"把沙箱吵醒。
 * active 走 ref:降温/回暖不重跑 effect,轮询循环自己看当下的状态。
 */
export function useDirectoryWatch(
  auth: EnvdAuth | undefined,
  path: string,
  opts: { enabled: boolean; active: boolean },
) {
  const queryClient = useQueryClient();
  const activeRef = useRef(opts.active);
  activeRef.current = opts.active;

  useEffect(() => {
    if (!opts.enabled || !auth) return;
    let watcherId: string | null = null;
    let busy = false;

    const arm = async () => {
      if (!activeRef.current) return; // 冻结/停止:武装会唤醒,等真实使用
      try {
        watcherId = await createWatcher(auth, path);
      } catch {
        watcherId = null; // 冷启动窗口或目录暂不可达;下一拍再试
      }
    };

    void arm();
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        if (watcherId === null) {
          await arm();
          return;
        }
        try {
          const events = await getWatcherEvents(auth, watcherId);
          if (events.length > 0) {
            void queryClient.invalidateQueries({
              queryKey: ['envdDir', auth.sandboxId, path],
            });
          }
        } catch {
          // 404:监听器随容器没了(停止/重建)。回到未武装态,由 arm
          // 的 active 闸决定何时重来 — 绝不在这里直接重建。
          watcherId = null;
        }
      })().finally(() => {
        busy = false;
      });
    }, 2000);

    return () => {
      clearInterval(timer);
      // 只有沙箱还醒着才顺手拆(RemoveWatcher 要容器活着);睡了就留给
      // 容器回收 — 一个 inotifywait 活不过下一次停止。
      if (watcherId !== null && activeRef.current) {
        void removeWatcher(auth, watcherId).catch(() => undefined);
      }
    };
  }, [auth, path, opts.enabled, queryClient]);
}

/**
 * 进程表。List 在服务端刻意不唤醒(读 daemon 内存),所以这里可以放心
 * 轮询;只在沙箱有物理容器时开启(active/frozen),停机沙箱没有进程表。
 */
export function useProcesses(auth: EnvdAuth | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['envdProcesses', auth?.sandboxId],
    queryFn: () => {
      if (!auth) throw new Error('缺少 envd 凭证');
      return listProcesses(auth);
    },
    enabled: enabled && auth !== undefined,
    refetchInterval: 2000,
    retry: false,
  });
}

export function useKillProcess(auth: EnvdAuth | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      pid: number;
      signal: 'SIGNAL_SIGTERM' | 'SIGNAL_SIGKILL';
    }) => {
      if (!auth) throw new Error('缺少 envd 凭证');
      return killProcess(auth, args.pid, args.signal);
    },
    onSettled: () => {
      if (auth) {
        void queryClient.invalidateQueries({
          queryKey: ['envdProcesses', auth.sandboxId],
        });
      }
    },
  });
}
