import { inject } from 'vitest';

/**
 * What every suite that talks to a gateway needs, black-box: a POST in the
 * native dialect, a poll, and the one question the configuration move
 * (2026-09-14) makes every write ask — has my change reached the node yet?
 * The gateway answers it itself: getConfig carries the fleet configuration
 * version, listNodes carries the version each node last said it runs.
 */

/** Polls until the probe answers something — nodes check in on their own clock, not ours. */
export async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function rpc(
  endpoint: string,
  path: string,
  payload: unknown = {},
  bearer: string,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: res.headers,
  };
}

export interface ListedNode {
  id: string;
  endpoint: string;
  reachable: boolean;
  configVersion: number | null;
  swapGb: number;
  lastCheckInAt: string | null;
  build: { commit: string } | null;
  reading: {
    sandboxes: {
      byState: { active: number; archived: number; restoring: number };
    };
  } | null;
  placedSinceCheckIn: number;
}

export async function listNodes(
  gateway: string,
  token: string,
): Promise<ListedNode[]> {
  const { status, body } = await rpc(gateway, '/listNodes', {}, token);
  if (status !== 200) throw new Error(`listNodes answered ${status}`);
  return (body as { nodes: ListedNode[] }).nodes;
}

/**
 * Waits until every node of the gateway runs the gateway's current
 * configuration version — a write at the gateway has then reached the
 * nodes' copies (the exam's nodes check in every second).
 */
export async function configSettled(
  gateway: string,
  token: string,
): Promise<number> {
  return until(async () => {
    const { status, body } = await rpc(gateway, '/getConfig', {}, token);
    if (status !== 200) throw new Error(`getConfig answered ${status}`);
    const version = (body as { configVersion: number }).configVersion;
    const nodes = await listNodes(gateway, token);
    return nodes.length > 0 && nodes.every((n) => n.configVersion === version)
      ? version
      : undefined;
  });
}

/** Node A's own gateway (a fleet of one) — where the fleet's configuration verbs answer in every mode. */
export const door = () => inject('dormiceGatewayEndpoint');

/** A write at node A's gateway, then the wait for node A to run it. */
export async function settled(): Promise<number> {
  return configSettled(door(), inject('dormiceToken'));
}
