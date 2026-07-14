import { useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';

/**
 * 全局错误兜底页(挂在 __root 的 errorComponent):会话失效已被
 * lib/api.ts 的 401 拦截转成跳登录,不会走到这里。这里收的是真异常 —
 * daemon 没起(fetch 直接 reject)、500、渲染崩溃。给一个能
 * 「重试 / 回登录」的中文界面,取代 router 默认的英文报错页。
 */
export function RootErrorBoundary({ error }: { error: unknown }) {
  const router = useRouter();
  const navigate = useNavigate();

  const message =
    error instanceof ApiError || error instanceof Error
      ? error.message
      : '发生了未知错误';

  // daemon 没起/网络不可达时 fetch 抛 TypeError('Failed to fetch'),
  // 原文对用户毫无信息量,换成能行动的话。
  const friendly = /failed to fetch|networkerror|load failed/i.test(message)
    ? '无法连接 daemon — 确认它在运行后重试。'
    : message;

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">出了点问题</h1>
        <p className="max-w-md text-sm text-muted-foreground">{friendly}</p>
      </div>
      <div className="flex gap-3">
        <Button onClick={() => router.invalidate()}>重试</Button>
        <Button variant="outline" onClick={() => navigate({ to: '/login' })}>
          返回登录
        </Button>
      </div>
    </div>
  );
}
