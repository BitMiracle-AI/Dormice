import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listTemplates, registerTemplate, removeTemplate } from '@/lib/api';

/**
 * 模板实体的数据层,一个文件聚合。模板变化在操作员速度(注册/删除都在
 * 眼前发生,mutation 自己失效缓存),不需要像沙箱那样轮询。
 */
export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: listTemplates,
    retry: false,
  });
}

/** 注册即 upsert:对已有名字重新注册 = 指向新镜像 = 模板升级的正门。 */
export function useRegisterTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; image: string }) =>
      registerTemplate(args.name, args.image),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates'] }),
  });
}

/** 删除由 daemon 裁决:还有沙箱引用时它回 409 并点名,这里只如实转达。 */
export function useRemoveTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => removeTemplate(name),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['templates'] }),
  });
}
