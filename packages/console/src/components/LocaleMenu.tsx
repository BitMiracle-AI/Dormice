import type { ReactElement } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getLocale, locales, setLocale } from '@/paraglide/runtime';

type Locale = (typeof locales)[number];

// 语言名固定用本族语显示,不随当前语言翻译 — 找回母语靠认出母语。
const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
};

/** 当前语言的本族语名,给 trigger 文案用。 */
export function currentLocaleLabel(): string {
  return LOCALE_LABELS[getLocale()];
}

/**
 * 语言菜单:trigger 由调用方给(侧栏按钮/登录页小按钮),菜单体共用。
 * setLocale 写 localStorage 后整页刷新(Paraglide 默认行为),控制台
 * 无长表单场景,不需要草稿暂存。
 *
 * 十种语言的菜单在矮窗口会顶破视口(侧栏入口在底部,菜单往上长),
 * 故给菜单体设视口相对高度上限并允许内滚 — 语言只增不减,列表长度
 * 不该是版式的隐含前提。
 */
export function LocaleMenu({ trigger }: { trigger: ReactElement }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent
        align="start"
        className="max-h-[min(60svh,20rem)] overflow-y-auto"
      >
        <DropdownMenuRadioGroup
          value={getLocale()}
          onValueChange={(value) => setLocale(value as Locale)}
        >
          {locales.map((locale) => (
            <DropdownMenuRadioItem key={locale} value={locale}>
              {LOCALE_LABELS[locale]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
