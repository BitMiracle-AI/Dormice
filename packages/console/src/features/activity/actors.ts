import {
  type ApiKey,
  apiKeyActorId,
  CONSOLE_ACTOR,
  ENV_TOKEN_ACTOR,
} from '@dormice/shared';

/**
 * 操作者的中文翻译 — kinds.ts 是 kind 的唯一翻译点,这里是 actor 的。
 * 词表在 shared/activity.ts:'env-token' / 'console' / 'apikey:<id>' /
 * null(=daemon 自动作业:闲置扫描、对账、归档,或不带账本凭证的数据面
 * 唤醒)。key 按 id 归因(名字可改、id 才稳定),显示时经密钥列表翻译回
 * 当前名 — 吊销是软删除、行永不消失,所以 id 永远翻得回来;密钥列表还
 * 没到手时退回截断 id,不装懂。词表之外的字符串原样示人,不翻译也不吞。
 */
export function actorLabel(
  actor: string | null,
  apiKeys: Pick<ApiKey, 'id' | 'name'>[] | undefined,
): string {
  if (actor === null) return '系统';
  if (actor === ENV_TOKEN_ACTOR) return '引导凭证';
  if (actor === CONSOLE_ACTOR) return '控制台';
  const keyId = apiKeyActorId(actor);
  if (keyId !== null) {
    const key = apiKeys?.find((k) => k.id === keyId);
    return `密钥 ${key ? key.name : keyId.slice(0, 8)}`;
  }
  return actor;
}
