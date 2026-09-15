import { describe, expect, it } from 'vitest';
import type { AskVerb } from '../ask';
import { readConfigVersion } from '../db/settings';
import { checkInOf, TEST_TOKEN, testGateway } from '../testing';

const authed = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * A fleet whose nodes answer templateUsers from a script: which names
 * each node reports for a template, or silence. The route is about the
 * decision, not the transport (ask.ts httpAsk is the transport, and
 * app.test.ts exercises it over sockets).
 */
function templatesGateway(users: Record<string, string[] | 'silent'>) {
  const askVerb: AskVerb = async (node, verb, _body, schema) => {
    if (verb !== 'templateUsers') throw new Error(`unexpected verb ${verb}`);
    const answer = users[node.id];
    if (answer === undefined || answer === 'silent') {
      return { kind: 'silent', why: 'ECONNREFUSED' };
    }
    return {
      kind: 'answer',
      value: schema.parse({ sandboxNames: answer }),
      headers: new Headers(),
    };
  };
  const { app, db, fleet } = testGateway({}, { askVerb });
  let host = 1;
  for (const id of Object.keys(users)) {
    const outcome = fleet.checkIn(checkInOf(id, `http://10.0.0.${host++}:80`));
    if ('refused' in outcome) throw new Error(outcome.refused);
  }
  return { app, db };
}

type App = ReturnType<typeof templatesGateway>['app'];

function rpc(
  app: App,
  url: string,
  payload: Record<string, unknown> = {},
  headers: Record<string, string> = authed,
) {
  return app.inject({ method: 'POST', url, headers, payload });
}

describe('templates on the gateway', () => {
  it('registers, lists, and counts the version up for the nodes; registering is admin-only', async () => {
    const { app, db } = templatesGateway({});
    const anon = await app.inject({
      method: 'POST',
      url: '/registerTemplate',
      payload: { name: 'py', image: 'img-a' },
    });
    expect(anon.statusCode).toBe(401);

    const res = await rpc(app, '/registerTemplate', {
      name: 'py',
      image: 'img-a',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().template).toMatchObject({ name: 'py', image: 'img-a' });
    expect(readConfigVersion(db)).toBe(2);
    const listed = await rpc(app, '/listTemplates');
    expect(listed.json().templates).toMatchObject([
      { name: 'py', image: 'img-a' },
    ]);

    const minted = await rpc(app, '/createApiKey', { name: 'robot' });
    const asKey = { authorization: `Bearer ${minted.json().token}` };
    expect(
      (await rpc(app, '/registerTemplate', { name: 'x', image: 'i' }, asKey))
        .statusCode,
    ).toBe(403);
    expect((await rpc(app, '/listTemplates', {}, asKey)).statusCode).toBe(403);
  });

  it('re-registering re-points the name and keeps its birth date — the upgrade verb; the same image is a no-op the nodes do not hear about', async () => {
    const { app, db } = templatesGateway({});
    const first = (
      await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' })
    ).json().template;
    expect(first.updatedAt).toBe(first.createdAt);
    const version = readConfigVersion(db);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const same = (
      await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' })
    ).json().template;
    expect(same.updatedAt).toBe(first.updatedAt);
    expect(readConfigVersion(db)).toBe(version);
    const second = (
      await rpc(app, '/registerTemplate', { name: 'py', image: 'img-b' })
    ).json().template;
    expect(second.image).toBe('img-b');
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(
      Date.parse(first.updatedAt),
    );
    expect(readConfigVersion(db)).toBe(version + 1);
    expect((await rpc(app, '/listTemplates')).json().templates).toHaveLength(1);
  });

  it("rejects a malformed name, and 'base' as reserved", async () => {
    const { app } = templatesGateway({});
    const bad = await rpc(app, '/registerTemplate', {
      name: '-bad',
      image: 'img',
    });
    expect(bad.statusCode).toBe(400);
    const base = await rpc(app, '/registerTemplate', {
      name: 'base',
      image: 'img',
    });
    expect(base.statusCode).toBe(400);
    expect(base.json().message).toMatch(/'base' is reserved/);
  });

  it('removal asks every node; a name in use anywhere is a 409 naming the sandboxes by node', async () => {
    const { app, db } = templatesGateway({ b: ['alice', 'bob'], c: [] });
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' });
    const version = readConfigVersion(db);
    const refused = await rpc(app, '/removeTemplate', { name: 'py' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain('alice, bob on node b');
    expect(refused.json().message).not.toContain('node c');
    expect((await rpc(app, '/listTemplates')).json().templates).toHaveLength(1);
    expect(readConfigVersion(db)).toBe(version);
  });

  it('a silent node holds the removal: 503 with Retry-After naming it', async () => {
    const { app } = templatesGateway({ b: [], c: 'silent' });
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' });
    const res = await rpc(app, '/removeTemplate', { name: 'py' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('15');
    expect(res.json().message).toMatch(/node c \(ECONNREFUSED\)/);
    expect((await rpc(app, '/listTemplates')).json().templates).toHaveLength(1);
  });

  it('with every node answering "unused" the template goes, the version counts up, and a second removal is an honest false', async () => {
    const { app, db } = templatesGateway({ b: [], c: [] });
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' });
    const version = readConfigVersion(db);
    expect((await rpc(app, '/removeTemplate', { name: 'py' })).json()).toEqual({
      removed: true,
    });
    expect(readConfigVersion(db)).toBe(version + 1);
    expect((await rpc(app, '/listTemplates')).json().templates).toEqual([]);
    expect((await rpc(app, '/removeTemplate', { name: 'py' })).json()).toEqual({
      removed: false,
    });
    expect(readConfigVersion(db)).toBe(version + 1);
  });

  it('with no node at all a removal needs nobody', async () => {
    const { app } = templatesGateway({});
    await rpc(app, '/registerTemplate', { name: 'py', image: 'img-a' });
    expect((await rpc(app, '/removeTemplate', { name: 'py' })).json()).toEqual({
      removed: true,
    });
  });
});
