import {
  EXEC_OUTPUT_LIMIT_BYTES,
  FILE_SIZE_LIMIT_BYTES,
  resolveSandboxPath,
} from '@dormice/shared';
import {
  type ContainerState,
  type ExecOptions,
  type ExecResult,
  type Executor,
  FileNotFoundError,
  FileTooLargeError,
  type FileToWrite,
  NotAFileError,
} from './executor';

/**
 * Directories the base image guarantees in every sandbox. The fake's
 * filesystem is otherwise implicit — a directory exists exactly when some
 * file lives under it, which is all mkdir -p semantics leave observable.
 */
const BUILTIN_DIRS = new Set(['/', '/home', '/home/user', '/tmp']);

/**
 * In-memory stand-in for the Docker+gVisor executor. Not a throwaway: it is
 * the permanent test double — unit tests and local development run on it;
 * only the e2e suite on a Linux machine exercises the real one.
 *
 * Deliberately strict: every method checks the state a real container would
 * have to be in, so a caller that would break against Docker breaks against
 * the fake too.
 */
export class FakeExecutor implements Executor {
  private readonly containers = new Map<string, ContainerState>();
  private readonly disks = new Set<string>();
  /**
   * Keyed like disks, not containers: files are the disk's content, so they
   * survive stop, start, and a vanished container object, and die only when
   * the disk does. That is the "the disk is the sandbox's body" invariant,
   * modeled where it physically lives.
   */
  private readonly files = new Map<string, Map<string, Buffer>>();

  /** Test hook: what does "reality" say about this sandbox? */
  stateOf(sandboxId: string): ContainerState | undefined {
    return this.containers.get(sandboxId);
  }

  /**
   * Test hook: the container disappears, the disk stays — a removal behind
   * the daemon's back, or a crash in the middle of destroy. The one-sided
   * drift the fake cannot produce by crashing for real.
   */
  vanishContainer(sandboxId: string): void {
    if (!this.containers.delete(sandboxId)) {
      throw new Error(`container ${sandboxId} is absent, cannot vanish`);
    }
  }

  /**
   * Test hook: a disk with no container and no row — a crash between
   * provisioning the disk and creating the container.
   */
  plantDiskResidue(sandboxId: string): void {
    this.disks.add(sandboxId);
  }

  async create(sandboxId: string): Promise<void> {
    if (this.containers.has(sandboxId)) {
      throw new Error(`container ${sandboxId} already exists`);
    }
    this.disks.add(sandboxId);
    this.files.set(sandboxId, new Map());
    this.containers.set(sandboxId, 'running');
  }

  async freeze(sandboxId: string): Promise<void> {
    this.expect(sandboxId, 'running');
    this.containers.set(sandboxId, 'paused');
  }

  async unfreeze(sandboxId: string): Promise<void> {
    this.expect(sandboxId, 'paused');
    this.containers.set(sandboxId, 'running');
  }

  async stop(sandboxId: string): Promise<void> {
    this.expect(sandboxId, 'paused');
    this.containers.set(sandboxId, 'stopped');
  }

  async start(sandboxId: string): Promise<void> {
    const actual = this.containers.get(sandboxId);
    if (actual === undefined) {
      // The container object is gone (pruned, removed behind the daemon's
      // back) but the disk survives — and the disk is the sandbox's data,
      // the container just a replaceable shell. Rebuild around the disk.
      if (!this.disks.has(sandboxId)) {
        throw new Error(`disk ${sandboxId} is absent, cannot start`);
      }
      this.containers.set(sandboxId, 'running');
      return;
    }
    this.expect(sandboxId, 'stopped');
    this.containers.set(sandboxId, 'running');
  }

  async destroy(sandboxId: string): Promise<void> {
    // Any state is fine, and so is a container that is already gone as long
    // as the disk remains (a pruned stopped sandbox): destroy promises
    // "container and disk gone", and half-gone still needs the other half.
    // Both absent means the ledger and reality disagree — a bug worth
    // hearing.
    const hadContainer = this.containers.delete(sandboxId);
    const hadDisk = this.disks.delete(sandboxId);
    this.files.delete(sandboxId);
    if (!hadContainer && !hadDisk) {
      throw new Error(`container ${sandboxId} is absent, cannot destroy`);
    }
  }

  async listContainers(): Promise<Map<string, ContainerState>> {
    // A copy: reality is observed, not handed out by reference.
    return new Map(this.containers);
  }

  async listDisks(): Promise<string[]> {
    return [...this.disks];
  }

  async removeDisk(sandboxId: string): Promise<void> {
    // Idempotent by contract: an absent disk already is the goal state.
    this.disks.delete(sandboxId);
    this.files.delete(sandboxId);
  }

  async exec(sandboxId: string, opts: ExecOptions): Promise<ExecResult> {
    this.expect(sandboxId, 'running');
    // The timeout races the command, same outcome as the real executor's
    // in-container `timeout --signal=KILL`: exit 137, partial output dropped.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ExecResult>((resolve) => {
      timer = setTimeout(
        () => resolve(fakeResult(137)),
        opts.timeoutSeconds * 1000,
      );
    });
    try {
      return await Promise.race([interpret(opts), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async writeFiles(sandboxId: string, files: FileToWrite[]): Promise<void> {
    this.expect(sandboxId, 'running');
    const disk = this.files.get(sandboxId) ?? new Map<string, Buffer>();
    this.files.set(sandboxId, disk);
    for (const file of files) {
      const path = resolveSandboxPath(file.path);
      if (this.isDirectory(disk, path)) {
        throw new NotAFileError(`not a regular file: ${path}`);
      }
      // Copy on the way in: the caller's buffer is theirs to reuse.
      disk.set(path, Buffer.from(file.content));
    }
  }

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
    this.expect(sandboxId, 'running');
    const disk = this.files.get(sandboxId) ?? new Map<string, Buffer>();
    const resolved = resolveSandboxPath(path);
    const content = disk.get(resolved);
    if (content !== undefined) {
      if (content.length > FILE_SIZE_LIMIT_BYTES) {
        throw new FileTooLargeError(
          `file too large: ${resolved} is ${content.length} bytes, limit ${FILE_SIZE_LIMIT_BYTES}`,
        );
      }
      return Buffer.from(content);
    }
    if (this.isDirectory(disk, resolved)) {
      throw new NotAFileError(`not a regular file: ${resolved}`);
    }
    throw new FileNotFoundError(`no such file: ${resolved}`);
  }

  /**
   * A path is a directory when the image ships it or some file lives under
   * it — the same observable truth mkdir -p leaves behind on a real disk.
   */
  private isDirectory(disk: Map<string, Buffer>, path: string): boolean {
    if (BUILTIN_DIRS.has(path)) return true;
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const existing of disk.keys()) {
      if (existing.startsWith(prefix)) return true;
    }
    return false;
  }

  private expect(sandboxId: string, wanted: ContainerState): void {
    const actual = this.containers.get(sandboxId);
    if (actual !== wanted) {
      throw new Error(
        `container ${sandboxId} is ${actual ?? 'absent'}, expected ${wanted}`,
      );
    }
  }
}

/**
 * Truncation lives in this single exit so every interpreted command obeys
 * the protocol cap. The interpreter only ever emits ASCII, so string length
 * equals byte length and slice() is an honest byte cap.
 */
function fakeResult(exitCode: number, stdout = '', stderr = ''): ExecResult {
  return {
    exitCode,
    stdout: stdout.slice(0, EXEC_OUTPUT_LIMIT_BYTES),
    stderr: stderr.slice(0, EXEC_OUTPUT_LIMIT_BYTES),
    stdoutTruncated: stdout.length > EXEC_OUTPUT_LIMIT_BYTES,
    stderrTruncated: stderr.length > EXEC_OUTPUT_LIMIT_BYTES,
  };
}

/**
 * A six-verb pocket bash: exactly what the contract exam and the e2e suite
 * need to exercise exec through the same questions the real executor
 * answers, nothing more. Not a shell — an unknown verb gets bash's honest
 * 127. If the real bash's wording ever proves different on the test
 * machine, this string yields: reality wins.
 */
async function interpret(opts: ExecOptions): Promise<ExecResult> {
  const command = opts.command.trim();
  const echoed = command.match(/^echo (.*)$/s)?.[1];
  if (echoed !== undefined) return fakeResult(0, `${echoed}\n`);
  const exitCode = command.match(/^exit (\d+)$/)?.[1];
  if (exitCode !== undefined) return fakeResult(Number(exitCode));
  const napSeconds = command.match(/^sleep (\d+(?:\.\d+)?)$/)?.[1];
  if (napSeconds !== undefined) {
    // A real timer on purpose: e2e races this against the daemon's
    // wall-clock idle scanner to prove the exec heartbeat works.
    await new Promise((resolve) =>
      setTimeout(resolve, Number(napSeconds) * 1000),
    );
    return fakeResult(0);
  }
  if (command === 'pwd') return fakeResult(0, `${opts.cwd ?? '/home/user'}\n`);
  const envKey = command.match(/^printenv (\w+)$/)?.[1];
  if (envKey !== undefined) {
    const value = opts.env?.[envKey];
    return value === undefined ? fakeResult(1) : fakeResult(0, `${value}\n`);
  }
  const seqEnd = command.match(/^seq 1 (\d+)$/)?.[1];
  if (seqEnd !== undefined) {
    let out = '';
    for (let i = 1; i <= Number(seqEnd); i++) out += `${i}\n`;
    return fakeResult(0, out);
  }
  const verb = command.split(/\s/)[0];
  return fakeResult(127, '', `bash: line 1: ${verb}: command not found\n`);
}
