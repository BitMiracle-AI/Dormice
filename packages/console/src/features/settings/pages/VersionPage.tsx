import { VersionCard } from '../components/VersionCard';

/**
 * daemon 的版本与升级,从设置页拆出的独立页(2026-07-16 用户拍板:
 * 版本是版本,设置是设置)。逻辑全在 VersionCard — 检测更新、一键升级
 * 弹窗、真进度;侧栏的可升级角标也挂在这一项上。窄内容页限宽 4xl,
 * 一张卡不摊大饼。
 */
export function VersionPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 md:p-6">
      <header>
        <h1 className="text-xl font-medium">版本</h1>
      </header>
      <VersionCard />
    </div>
  );
}
