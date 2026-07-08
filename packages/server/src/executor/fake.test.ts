import { describe, expect, it } from 'vitest';
import { FakeExecutor } from './fake';

describe('FakeExecutor', () => {
  it('walks the full container lifecycle', async () => {
    const executor = new FakeExecutor();
    await executor.create('a');
    expect(executor.stateOf('a')).toBe('running');
    await executor.freeze('a');
    expect(executor.stateOf('a')).toBe('paused');
    await executor.unfreeze('a');
    expect(executor.stateOf('a')).toBe('running');
    await executor.freeze('a');
    await executor.stop('a');
    expect(executor.stateOf('a')).toBe('stopped');
    await executor.start('a');
    expect(executor.stateOf('a')).toBe('running');
  });

  it('rejects creating the same container twice', async () => {
    const executor = new FakeExecutor();
    await executor.create('a');
    await expect(executor.create('a')).rejects.toThrow(/already exists/);
  });

  it('rejects operations from the wrong state', async () => {
    const executor = new FakeExecutor();
    await executor.create('a');
    await expect(executor.unfreeze('a')).rejects.toThrow(/expected paused/);
    await expect(executor.stop('a')).rejects.toThrow(/expected paused/);
    await expect(executor.start('a')).rejects.toThrow(/expected stopped/);
  });

  it('rejects operations on absent containers', async () => {
    const executor = new FakeExecutor();
    await expect(executor.freeze('ghost')).rejects.toThrow(/absent/);
  });
});
