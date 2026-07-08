import { describe, expect, it } from 'vitest';
import { describeExecutorContract } from './contract';
import { FakeExecutor } from './fake';

describeExecutorContract('FakeExecutor', () => {
  const executor = new FakeExecutor();
  return {
    executor,
    vanishContainer: async (sandboxId: string) =>
      executor.vanishContainer(sandboxId),
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
