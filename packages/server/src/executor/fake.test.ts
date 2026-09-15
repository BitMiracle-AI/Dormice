import { describe, expect, it } from 'vitest';
import { describeExecutorContract } from './contract';
import { FAKE_BASE_IMAGE, FakeExecutor } from './fake';

describeExecutorContract('FakeExecutor', () => {
  const executor = new FakeExecutor();
  return {
    executor,
    vanishContainer: async (sandboxId: string) =>
      executor.vanishContainer(sandboxId),
    baseImage: FAKE_BASE_IMAGE,
    // Any string: the fake plays whatever image it is asked to.
    altImage: 'fake-alt-image',
    imageOf: async (sandboxId: string) => {
      const image = await executor.imageOf(sandboxId);
      if (image === null) {
        throw new Error(`no shell for ${sandboxId}`);
      }
      return image;
    },
  };
});

describe('FakeExecutor test hooks', () => {
  it('exposes container state via stateOf', async () => {
    const executor = new FakeExecutor();
    await executor.create('a');
    expect(executor.stateOf('a')).toBe('running');
    expect(executor.stateOf('ghost')).toBeUndefined();
  });

  it('boots the live base image when a birth names none, and ensureImage pulls an image once and answers present after', async () => {
    let base = 'base:1';
    const executor = new FakeExecutor(undefined, undefined, () => base);
    await executor.create('a');
    expect(await executor.imageOf('a')).toBe('base:1');
    base = 'base:2';
    expect(executor.baseImage()).toBe('base:2');
    await executor.create('b');
    expect(await executor.imageOf('b')).toBe('base:2');
    // The base is always on the host; anything else is pulled once.
    expect(await executor.ensureImage('base:2')).toBe('present');
    expect(await executor.ensureImage('tpl:1')).toBe('pulled');
    expect(await executor.ensureImage('tpl:1')).toBe('present');
    expect(executor.pulled).toEqual(['tpl:1']);
  });
});
