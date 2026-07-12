import type { Sandbox } from '@dormice/shared';
import { useEffect, useState } from 'react';
import { formatDuration, nextLifecycleStep } from '../format';

/**
 * 详情页头部的"下一步降温"倒计时:把生命周期引擎从一张策略表变成看得
 * 见的东西 — "再空闲 4分12秒 冻结"。逐秒走字纯属前端(列表缓存里的
 * lastActiveAt + 策略就能算),到 0 不是异常而是"等下一轮扫描"。
 */
export function LifecycleCountdown({ sandbox }: { sandbox: Sandbox }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const step = nextLifecycleStep(sandbox, now);
  if (!step) return null;

  return (
    <span className="text-sm tabular-nums text-muted-foreground">
      {step.remainingSeconds === null
        ? `永不${step.action}`
        : step.remainingSeconds === 0
          ? `即将${step.action}(等下一轮扫描)`
          : `再空闲 ${formatDuration(step.remainingSeconds)} 就${step.action}`}
    </span>
  );
}
