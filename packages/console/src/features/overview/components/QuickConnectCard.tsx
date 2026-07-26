import { Link } from '@tanstack/react-router';
import { Snippet } from '@/components/Snippet';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { e2bQuickSnippet } from '@/features/connect/snippets';
import { m } from '@/paraglide/messages';

/**
 * 总览页的快速接入卡:官方 e2b 包换两个 URL 直连 — 产品的一句话卖点,
 * 放在第一屏。完整的三种接入方式(E2B / 原生 SDK / CLI)在连接页。
 */
export function QuickConnectCard() {
  const origin = window.location.origin;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{m.overview_quick_title()}</CardTitle>
        <CardDescription>
          {m.overview_quick_desc_1()}
          <code className="font-mono">e2b</code>
          {m.overview_quick_desc_2()}
          <code className="font-mono">/etc/dormice/env</code>
          {m.overview_quick_desc_3()}{' '}
          <Link to="/connect" className="text-primary hover:underline">
            {m.overview_quick_all_methods()}
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Snippet code={e2bQuickSnippet(origin)} />
      </CardContent>
    </Card>
  );
}
