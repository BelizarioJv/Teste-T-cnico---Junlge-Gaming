import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Executável do Bun usado para subir processos filhos (override: BUN_BIN). */
export const BUN = process.env.BUN_BIN ?? 'bun';

export const bunAvailable = (() => {
  try {
    return spawnSync(BUN, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

/** Em CI (REQUIRE_MULTIPROCESS=1) a ausência do Bun é erro, não skip. */
export const skipMultiProcess = !bunAvailable && process.env.REQUIRE_MULTIPROCESS !== '1';

export interface RunningProcess {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
  waitForOutput: (marker: string, timeoutMs?: number) => Promise<void>;
}

export function startFixture(fixture: string, env: Record<string, string>): RunningProcess {
  const child = spawn(BUN, [resolve('test/integration/fixtures', fixture)], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });

  const exited = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => resolveExit(code));
  });

  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    waitForOutput: async (marker, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!out.includes(marker)) {
        if (child.exitCode !== null) {
          throw new Error(`Processo saiu (${child.exitCode}) antes de "${marker}": ${err}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`Tempo esgotado aguardando "${marker}". stderr: ${err}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

/** Executa até o fim e devolve o JSON da última linha do stdout. */
export async function runFixtureJson<T>(fixture: string, env: Record<string, string>): Promise<T> {
  const proc = startFixture(fixture, env);
  const code = await proc.exited;

  if (code !== 0) {
    throw new Error(`${fixture} saiu com código ${code}: ${proc.stderr()}`);
  }

  const lines = proc.stdout().trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as T;
}
