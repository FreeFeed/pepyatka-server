import { spawn, type SpawnOptionsWithoutStdio } from 'child_process';

/**
 * Spawns a child process and returns a promise resolving with its output
 *
 * @param {string} command - The command to run.
 * @param {Array<string>} args - List of string arguments.
 * @param {SpawnOptionsWithoutStdio} options - Options to pass to the spawn function.
 * @returns {Promise<{stdout: string, stderr: string}>} - Promise that resolves with the output.
 */
export function spawnAsync(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptionsWithoutStdio = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data.toString()));
    child.stderr.on('data', (data) => (stderr += data.toString()));

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Process exited with code ${code}\n${stderr}`));
      }
    });

    child.on('error', (err) => reject(err));
  });
}
