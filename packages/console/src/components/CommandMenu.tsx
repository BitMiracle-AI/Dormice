import { ArrowRight01Icon, PackageIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { NAV_GROUPS } from '@/components/nav';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { STATE_LABELS } from '@/features/sandboxes/format';
import { useSandboxes } from '@/features/sandboxes/hooks/useSandboxes';
import { MOCK_PAGES_ENABLED } from '@/lib/mock';

/**
 * 沙箱条目单拆一个组件:useSandboxes 的 2 秒轮询只在面板打开时才该跑,
 * hook 不能条件调用,但组件可以条件挂载。缓存和列表页共享同一个 key,
 * 打开面板时多半直接命中。
 */
function SandboxItems({ onGo }: { onGo: (name: string) => void }) {
  const query = useSandboxes();
  const sandboxes = query.data?.sandboxes ?? [];
  if (sandboxes.length === 0) return null;
  return (
    <CommandGroup heading="沙箱">
      {sandboxes.map((sandbox) => (
        <CommandItem
          key={sandbox.id}
          value={`sandbox ${sandbox.name}`}
          onSelect={() => onGo(sandbox.name)}
        >
          <HugeiconsIcon icon={PackageIcon} strokeWidth={1.8} />
          <span className="font-mono">{sandbox.name}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {STATE_LABELS[sandbox.state]}
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/**
 * ⌘K / Ctrl+K 命令面板:跳页面、按 name 跳沙箱。纯键盘入口(2026-07-16
 * 用户拍板去掉侧栏搜索按钮,快捷键是唯一门),组件不渲染可见节点、只挂
 * 快捷键和弹窗,登录后全站可用;它只做导航 — 动作(销毁/重建)留在各自
 * 页面的确认流程里,快捷键不该绕过"删了就没有了"的那道闸。
 */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const goPage = (to: string) => {
    setOpen(false);
    void navigate({ to });
  };
  const goSandbox = (name: string) => {
    setOpen(false);
    void navigate({
      to: '/sandboxes/$name',
      params: { name },
    });
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="命令面板"
      description="跳转到页面或沙箱"
    >
      <CommandInput placeholder="搜页面、沙箱" />
      <CommandList>
        <CommandEmpty>没有匹配的结果。</CommandEmpty>
        <CommandGroup heading="页面">
          {NAV_GROUPS.flatMap((group) => group.items)
            .filter((item) => !item.mock || MOCK_PAGES_ENABLED)
            .map((item) => (
              <CommandItem
                key={item.to}
                value={`page ${item.label}`}
                onSelect={() => goPage(item.to)}
              >
                <HugeiconsIcon icon={item.icon} strokeWidth={1.8} />
                {item.label}
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  className="ml-auto size-3.5 text-muted-foreground"
                />
              </CommandItem>
            ))}
        </CommandGroup>
        {open && <SandboxItems onGo={goSandbox} />}
      </CommandList>
    </CommandDialog>
  );
}
