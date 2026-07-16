import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
} from '@/lib/api';

/**
 * API 密钥实体的数据层,一个文件聚合。密钥变化在操作员速度(铸造/吊销
 * 都在眼前发生,mutation 自己失效缓存),不需要像沙箱那样轮询。
 */
export function useApiKeys() {
  return useQuery({
    queryKey: ['apiKeys'],
    queryFn: listApiKeys,
    retry: false,
  });
}

/** 铸造:响应里的 token 只出现这一次 — 展示与复制归调用方,这里只管数据。 */
export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, expiresAt }: { name: string; expiresAt?: string }) =>
      createApiKey(name, expiresAt),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['apiKeys'] }),
  });
}

/** 就地编辑:改名/改过期/启停都是这一个动词,缺省字段不动。 */
export function useUpdateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      name?: string;
      expiresAt?: string | null;
      disabled?: boolean;
    }) => updateApiKey(id, patch),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['apiKeys'] }),
  });
}

/** 软吊销:行留作轮换历史,凭证下一个请求就失效。按 id 寻址。 */
export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['apiKeys'] }),
  });
}
