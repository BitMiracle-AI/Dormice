import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mintEnvdToken } from '@/lib/api';
import {
  downloadFile,
  type EnvdAuth,
  killProcess,
  listDir,
  listProcesses,
  makeDir,
  moveEntry,
  removeEntry,
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
