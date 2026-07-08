import { describe, expect, it } from 'vitest';
import { describeExecutorContract } from './contract';
import { FakeExecutor } from './fake';

describeExecutorContract('FakeExecutor', () => new FakeExecutor());

describe('FakeExecutor test hooks', () => {
  it('exposes container state via stateOf', async () => {
    const executor = new FakeExecutor();
    await executor.create('a');
    expect(executor.stateOf('a')).toBe('running');
    expect(executor.stateOf('ghost')).toBeUndefined();
  });
});
