import type { SandboxEntry, WatchEvent } from './executor';

/**
 * Every script the DockerExecutor runs inside a sandbox, with the parsers
 * for their output. A script and its parser are one wire format — they
 * change together, which is why they share this file. No user input is
 * ever spliced into a script: arguments travel as positional shell
 * parameters ($1, $2, ...), set by the exec's argv.
 */

/**
 * In-container deadline for file operations, same mechanism as exec's
 * (host-side disconnects cannot kill an in-container process). Not a user
 * knob: 16 MiB on a local ext4 is subsecond work — this guard only exists
 * so a pathological target cannot hang the daemon's request forever.
 */
export const FILE_OP_TIMEOUT_SECONDS = 60;

/**
 * The file-op scripts talk back through exit codes of our choosing — private
 * numbers between the daemon and its own script, no user command runs inside.
 * They map 1:1 onto the typed file errors both executors must throw.
 */
export const NO_SUCH_FILE_EXIT = 44;
export const NOT_A_FILE_EXIT = 45;
export const TOO_LARGE_EXIT = 46;
export const NOT_A_DIR_EXIT = 47;
export const ALREADY_EXISTS_EXIT = 48;

/**
 * $1 = absolute path. Refuses a target that exists but is not a regular
 * file (directory, FIFO — `cat >` into a FIFO would block forever), creates
 * the parents, then streams stdin into the file. Runs as uid 1000, so
 * in-sandbox permissions apply honestly, and path resolution — symlinks
 * included — happens inside the container, where there is no host to
 * escape to.
 */
export const WRITE_FILE_SCRIPT = [
  `[ ! -e "$1" ] || [ -f "$1" ] || exit ${NOT_A_FILE_EXIT}`,
  'mkdir -p -- "$(dirname -- "$1")" && exec cat > "$1"',
].join('\n');

/** $1 = absolute path, $2 = size limit in bytes. Size gate before content: an over-limit file is refused, never truncated. */
export const READ_FILE_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `[ -f "$1" ] || exit ${NOT_A_FILE_EXIT}`,
  'size=$(stat -c %s -- "$1") || exit 1',
  `[ "$size" -le "$2" ] || { echo "$size" >&2; exit ${TOO_LARGE_EXIT}; }`,
  'exec cat -- "$1"',
].join('\n');

/**
 * Streaming file transfers have no size cap, so their in-container deadline
 * must fit a quota-sized file crawling to a slow client — generous, but
 * still a bound so a wedged transfer cannot hold an exec forever.
 */
export const STREAM_FILE_OP_TIMEOUT_SECONDS = 3600;

/** Ceiling for one directory listing; past it the listing errors instead of silently losing entries. */
export const LIST_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/** $1 = absolute path. READ_FILE_SCRIPT without the size gate — the streaming read is the uncapped path. */
export const READ_FILE_STREAM_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `[ -f "$1" ] || exit ${NOT_A_FILE_EXIT}`,
  'exec cat -- "$1"',
].join('\n');

/**
 * $1 = absolute dir, $2 = depth. One NUL-terminated record per entry, tab
 * separated with the path last, so a path containing tabs still parses
 * (nothing else can contain a tab, and a path cannot contain a NUL).
 */
export const LIST_DIR_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `[ -d "$1" ] || exit ${NOT_A_DIR_EXIT}`,
  `exec find "$1" -mindepth 1 -maxdepth "$2" -printf '%y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%p\\0'`,
].join('\n');

/** $1 = absolute path. --printf, not -c: only --printf interprets \t. */
export const STAT_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `exec stat --printf '%F\\t%s\\t%Y\\t%a\\t%U\\t%G' -- "$1"`,
].join('\n');

/** $1 = absolute path. Exists (whatever it is) -> "already there", else mkdir -p. */
export const MAKE_DIR_SCRIPT = [
  `[ ! -e "$1" ] || exit ${ALREADY_EXISTS_EXIT}`,
  'exec mkdir -p -- "$1"',
].join('\n');

/** $1 = source, $2 = destination. -T = rename(2) semantics: never "move into". */
export const MOVE_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  'exec mv -T -- "$1" "$2"',
].join('\n');

export const REMOVE_SCRIPT = [
  `[ -e "$1" ] || exit ${NO_SUCH_FILE_EXIT}`,
  'exec rm -rf -- "$1"',
].join('\n');

/**
 * A watcher may outlive any one request, but not the sandbox's day — the
 * same backstop as e2b-surface execs, physical cleanup only.
 */
export const WATCH_BACKSTOP_SECONDS = 24 * 60 * 60;

/**
 * $1 = pidfile, $2 = recursive flag (`-r` or empty), $3 = watched dir.
 * The existence checks run in-script: one round trip, no gap for the path
 * to change under a separate stat. Readiness is inotifywait's own
 * "Watches established." on stderr — measured under gVisor 2026-07-10,
 * along with -r picking up directories created after the watch began.
 */
export const WATCH_SCRIPT = [
  'echo "$$" > "$1"',
  `[ -e "$3" ] || exit ${NO_SUCH_FILE_EXIT}`,
  `[ -d "$3" ] || exit ${NOT_A_DIR_EXIT}`,
  // $2 rides unquoted on purpose: empty must vanish, not become an argument.
  `exec timeout --signal=KILL ${WATCH_BACKSTOP_SECONDS} inotifywait -m $2 -e create,modify,delete,move,attrib --format '%e|%w%f' -- "$3"`,
].join('\n');

/**
 * One inotifywait line -> wire events. A line reads `OPS|/abs/path` with
 * OPS comma-separated; `ISDIR` and anything unmapped fall through silently.
 * MOVED_FROM/MOVED_TO land as rename/create — fsnotify's reading, which is
 * what the E2B wire speaks. Events on the watched directory itself (empty
 * name) are dropped, like real envd's "." edge.
 */
export function parseInotifyLine(line: string, base: string): WatchEvent[] {
  const cut = line.indexOf('|');
  if (cut === -1) return [];
  const eventPath = line.slice(cut + 1);
  const prefix = base === '/' ? '/' : `${base}/`;
  if (!eventPath.startsWith(prefix) || eventPath.length === prefix.length) {
    return [];
  }
  const name = eventPath.slice(prefix.length);
  const events: WatchEvent[] = [];
  for (const op of line.slice(0, cut).split(',')) {
    const type =
      op === 'CREATE' || op === 'MOVED_TO'
        ? ('create' as const)
        : op === 'MODIFY'
          ? ('write' as const)
          : op === 'DELETE'
            ? ('remove' as const)
            : op === 'MOVED_FROM'
              ? ('rename' as const)
              : op === 'ATTRIB'
                ? ('chmod' as const)
                : undefined;
    if (type) events.push({ name, type });
  }
  return events;
}

/**
 * Wrapper every execStream command runs under, so the handle can signal it
 * later. $1 = pidfile, $2 = timeout seconds, $3 = the user's command.
 * The exec chain keeps the pid stable: the recorded $$ is the bash that
 * becomes `timeout`, and GNU timeout itself (without --foreground) calls
 * setpgid(0,0) — that same pid becomes a fresh process-group leader, so
 * one `kill -- -pid` reaps the command and all its descendants.
 * Deliberately NOT setsid --wait for the group: measured 2026-07-10,
 * setsid reports a signal-killed child as the raw signal number (9/15)
 * where the shell convention — and E2B — speak 128+N; timeout's own
 * signal propagation (it re-raises on itself) preserves 137/143.
 */
export function execStreamWrapper(loginShell: boolean): string {
  const shell = loginShell ? 'bash -l -c' : 'bash -c';
  return [
    'echo "$$" > "$1"',
    `exec timeout --signal=KILL "$2" ${shell} "$3"`,
  ].join('\n');
}

/**
 * $1 = pidfile, $2 = signal name (SIGKILL/SIGTERM). The brief wait covers
 * the honest race of a signal arriving before the wrapper's first line has
 * written the pidfile. Group kill first; a leader that already died with
 * children lingering still gets the single-pid fallback.
 */
export const SIGNAL_SCRIPT = [
  'for _ in $(seq 1 40); do [ -s "$1" ] && break; sleep 0.05; done',
  'p=$(cat "$1") || exit 1',
  '[ -n "$p" ] || exit 1',
  'kill -s "$2" -- "-$p" 2>/dev/null || exec kill -s "$2" "$p"',
].join('\n');

/**
 * $1 = pidfile. The PTY session: an interactive login shell, nothing else.
 * Deliberately no timeout wrapper (GNU timeout puts the child in its own
 * process group, which wrecks interactive job control with SIGTTIN) and no
 * setsid (a Tty exec is born session leader holding the controlling
 * terminal; setsid would take the terminal away). The shell's own group is
 * what the pidfile kill reaps; foreground jobs follow the closing pty
 * master via SIGHUP. Lifetime is bounded by the sandbox's own.
 */
export const PTY_WRAPPER = ['echo "$$" > "$1"', 'exec bash -i -l'].join('\n');

/** One `find -printf` record (see LIST_DIR_SCRIPT) -> entry. */
export function entryFromFindRecord(record: string): SandboxEntry {
  const fields = record.split('\t');
  const [kind = '', size = '', mtime = '', mode = '', owner = '', group = ''] =
    fields;
  // The path is everything after the sixth tab — its own tabs survive.
  const path = fields.slice(6).join('\t');
  return {
    name: path.slice(path.lastIndexOf('/') + 1) || '/',
    path,
    type: kind === 'f' ? 'file' : kind === 'd' ? 'dir' : 'other',
    sizeBytes: Number(size),
    modifiedTime: new Date(Number(mtime) * 1000).toISOString(),
    mode: Number.parseInt(mode, 8),
    owner,
    group,
  };
}

/** One `stat --printf` line (see STAT_SCRIPT) -> entry. */
export function entryFromStatLine(
  resolved: string,
  line: string,
): SandboxEntry {
  const [kind = '', size = '', mtime = '', mode = '', owner = '', group = ''] =
    line.split('\t');
  return {
    name: resolved.slice(resolved.lastIndexOf('/') + 1) || '/',
    path: resolved,
    // %F says "regular file" or "regular empty file" — both are files.
    type: kind.startsWith('regular')
      ? 'file'
      : kind === 'directory'
        ? 'dir'
        : 'other',
    sizeBytes: Number(size),
    modifiedTime: new Date(Number(mtime) * 1000).toISOString(),
    mode: Number.parseInt(mode, 8),
    owner,
    group,
  };
}
