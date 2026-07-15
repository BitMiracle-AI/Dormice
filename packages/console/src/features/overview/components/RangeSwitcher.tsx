import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  TIMELINE_RANGES,
  type TimelineRangeKey,
} from '../hooks/useFleetTimeline';

// base-ui Select 的已知坑:value ≠ 展示文案时必须传 items,否则触发器
// 显示不了选中项文案(RULES/前端.md)。
const RANGE_ITEMS = TIMELINE_RANGES.map((r) => ({
  value: r.key,
  label: r.label,
}));

/**
 * 全局时间档位切换:放页头右侧,统一驱动统计卡与走势图 — 档位是整页
 * 的观察窗口,不是某张图的私有旋钮。桌面 ToggleGroup,移动降级 Select。
 */
export function RangeSwitcher({
  range,
  onChange,
}: {
  range: TimelineRangeKey;
  onChange: (range: TimelineRangeKey) => void;
}) {
  return (
    <>
      <ToggleGroup
        value={[range]}
        onValueChange={(value: unknown[]) => {
          // base-ui 允许再点一下取消选中(空数组)— 档位必须常有,忽略。
          const next = value[0];
          if (typeof next === 'string') onChange(next as TimelineRangeKey);
        }}
        variant="outline"
        size="sm"
        className="hidden sm:flex"
      >
        {TIMELINE_RANGES.map((r) => (
          <ToggleGroupItem key={r.key} value={r.key}>
            {r.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Select
        items={RANGE_ITEMS}
        value={range}
        onValueChange={(value) => {
          if (typeof value === 'string') onChange(value as TimelineRangeKey);
        }}
      >
        <SelectTrigger size="sm" className="flex w-28 sm:hidden">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {TIMELINE_RANGES.map((r) => (
            <SelectItem key={r.key} value={r.key}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
