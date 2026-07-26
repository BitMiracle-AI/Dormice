import type { UpdateSettingsRequest } from '@dormice/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { updateSettings } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';

/**
 * updateSettings 的提交半件,运营旋钮卡与归档卡共用:pending/error 状态
 * + 成功 toast 关窗。失败也刷新 config — swap 的 500 语义是"目标已存但
 * 应用失败",账本真的变了,行里必须立刻说真话;设置页读 config,总览的
 * 容量卡走 getHostMetrics 自己的轮询。
 */
export function useUpdateSettings(onDone: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (patch: UpdateSettingsRequest, done: string) => {
    setPending(true);
    setError(null);
    try {
      await updateSettings(patch);
      toast.success(done);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      setPending(false);
    }
  };
  return { pending, error, setError, submit };
}
