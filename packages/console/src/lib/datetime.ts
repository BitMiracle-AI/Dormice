import { getLocale } from '@/paraglide/runtime';

// 日期格式跟 UI 语言(getLocale)而非浏览器区域:切语言换的是整个界面,
// 日期格式也在内;裸调 toLocaleString 会让同一页面混出两种格式源。
// 全站日期格式化只走这两个函数(单一裁决点),带 options 的定制格式化
// (MetricsPanel/overview 的时间轴刻度)自己传 getLocale(),同一纪律。
export function formatDateTime(at: string | number | Date): string {
  return new Date(at).toLocaleString(getLocale());
}

export function formatDate(at: string | number | Date): string {
  return new Date(at).toLocaleDateString(getLocale());
}
