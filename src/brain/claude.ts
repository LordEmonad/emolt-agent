import { execFileSync } from 'child_process';

export function askClaude(prompt: string): string {
  try {
    const result = execFileSync('claude', ['-p', '--output-format', 'text'], {
      encoding: 'utf-8',
      input: prompt, // Pass prompt via stdin - no temp files, no shell injection
      maxBuffer: 2 * 1024 * 1024, // 2MB buffer
      timeout: 180000 // 3 min timeout
    });
    return result.trim();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Claude] Invocation failed:', msg);
    return ''; // Return empty on failure, heartbeat will retry next cycle
  }
}
