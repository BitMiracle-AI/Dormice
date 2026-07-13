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
});
