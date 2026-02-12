import { execFileSync, execFile } from 'child_process';

export function askClaude(prompt: string): string {
  try {
    const result = execFileSync('claude', ['-p', '--output-format', 'text'], {
      encoding: 'utf-8',
      input: prompt,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 180000
    });
    return result.trim();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Claude] Invocation failed:', msg);
    return '';
  }
}

export function askClaudeAsync(prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let settled = false;

    const child = execFile('claude', ['-p', '--output-format', 'text'], {
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 180000,
    }, (error, stdout) => {
      if (settled) return;
      if (signal?.aborted) {
        settled = true;
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      settled = true;
      if (error) {
        console.error('[Claude] Async invocation failed:', error.message);
        resolve('');
        return;
      }
      resolve((stdout || '').trim());
    });

    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    if (signal) {
      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', () => signal.removeEventListener('abort', onAbort));
    }
  });
}
