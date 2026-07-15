import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createApiKey, listApiKeys, revokeApiKey } from '@/lib/api';

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
    mutationFn: (name: string) => createApiKey(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['apiKeys'] }),
  });
}

/** 软吊销:行留作轮换历史,凭证下一个请求就失效。 */
export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => revokeApiKey(name),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['apiKeys'] }),
  });
}
