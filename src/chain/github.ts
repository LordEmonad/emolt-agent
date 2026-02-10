// GitHub star count fetcher for EMOLT repo
// Uses unauthenticated API (60 req/hr) or GITHUB_TOKEN if available (5000 req/hr)

export interface GitHubStarData {
  stars: number;
  forks: number;
  repoName: string;
  fetchedAt: number;
}

const REPO = 'LordEmonad/emolt-agent';

export async function fetchGitHubStars(): Promise<GitHubStarData | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'emolt-agent',
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[GitHub] API returned ${res.status}`);
      return null;
    }

    const data = await res.json() as { stargazers_count?: number; forks_count?: number; full_name?: string };
    return {
      stars: data.stargazers_count ?? 0,
      forks: data.forks_count ?? 0,
      repoName: data.full_name ?? REPO,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    console.warn('[GitHub] Failed to fetch stars:', error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
