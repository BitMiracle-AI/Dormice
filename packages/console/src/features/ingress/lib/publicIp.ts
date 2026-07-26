import type { IngressDomainStatus } from '@dormice/shared';

/**
 * 本机公网 IP 的来源是"浏览器此刻怎么够到这台服务器"——这比 daemon
 * 自己猜可靠(云上 NAT 环境 daemon 只看得见内网地址):引导期直接用
 * IP 访问,地址栏就是答案;已经走域名访问,当前域名(或任一绿灯域名)
 * 的解析值就是答案。两个来源都没有(如 localhost dev)则诚实返回 null。
 * 控制台域名区与沙箱域名卡共用一份判断。
 */
export function detectPublicIp(statuses: IngressDomainStatus[]): string | null {
  const host = window.location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const here = statuses.find(
    (status) => status.domain === host && status.probe.dnsAddresses.length > 0,
  );
  const ready = statuses.find(
    (status) => status.probe.tlsOk && status.probe.dnsAddresses.length > 0,
  );
  return (here ?? ready)?.probe.dnsAddresses[0] ?? null;
}
