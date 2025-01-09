/* eslint-disable no-redeclare */
import { spawn, type SpawnOptionsWithoutStdio } from 'child_process';

export type SpawnAsyncOptions = SpawnOptionsWithoutStdio & { binary?: true };

export type SpawnAsyncArgs = (string | string[])[];

/**
 * Spawns a child process and returns a promise resolving with its output
 */
export function spawnAsync(
  command: string,
  args: SpawnAsyncArgs,
  options: SpawnOptionsWithoutStdio & { binary: true },
): Promise<{ stdout: Buffer; stderr: string }>;
export function spawnAsync(
  command: string,
  args: SpawnAsyncArgs,
  options?: SpawnOptionsWithoutStdio,
): Promise<{ stdout: string; stderr: string }>;
export function spawnAsync(
  command: string,
  args: SpawnAsyncArgs,
  options: SpawnOptionsWithoutStdio & { binary?: true } = {},
): Promise<{ stdout: string | Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args.flat(), options);
    const { binary = false } = options;

    const stdoutParts: Uint8Array[] = [];
    let stderr = '';
    child.stdout.on('data', (data) => stdoutParts.push(data));
    child.stderr.on('data', (data) => (stderr += data.toString()));

    child.on('close', (code) => {
      if (code === 0) {
        const stdout = Buffer.concat(stdoutParts);
        resolve({ stdout: binary ? stdout : stdout.toString(), stderr });
      } else {
        reject(new Error(`Process exited with code ${code}\n${stderr}`));
      }
    });

    child.on('error', (err) => reject(err));
  });
}
