import { PlusSignCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';

export interface FilterOption {
  /** '' 即「全部」(不筛)。 */
  value: string;
  label: string;
}

/**
 * 工具栏筛选下拉(风格参考 clawsgo faceted-filter):虚线 outline 按钮 +
 * 加号图标,选中后竖分隔 + secondary 徽章显示当前值 — 一眼看出"筛了
 * 什么"。单选语义,选项少且固定,body 用 DropdownMenuRadioGroup,
 * 不上 Command 那套搜索壳。
 */
export function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  const selected = value
    ? options.find((option) => option.value === value)
    : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="border-dashed" />}
      >
        <HugeiconsIcon
          icon={PlusSignCircleIcon}
          strokeWidth={2}
          className="size-4"
        />
        {label}
        {selected && (
          <>
            {/* 组件自带 data-vertical:self-stretch,限高后会钉上沿 — 压回居中。 */}
            <Separator
              orientation="vertical"
              className="mx-0.5 !h-4 !self-center"
            />
            <Badge variant="secondary" className="rounded-sm px-1 font-normal">
              {selected.label}
            </Badge>
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="">全部</DropdownMenuRadioItem>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
