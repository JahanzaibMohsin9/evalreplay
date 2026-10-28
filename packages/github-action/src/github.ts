import { MARKER } from './comment.js';

/** The GitHub REST API, through fetch: the action has no dependencies to bundle. */
export class GitHub {
  constructor(
    private readonly token: string,
    private readonly api = 'https://api.github.com',
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ) {
    return fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async fail(res: Response, what: string): Promise<never> {
    const detail = await res.text().catch(() => '');
    throw new Error(`${what}: GitHub answered ${res.status} ${detail.slice(0, 200)}`);
  }

  /** A file's content at a commit, or undefined when the file isn't there. */
  async fileAt(repo: string, path: string, ref: string): Promise<string | undefined> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.request(
      'GET',
      `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      undefined,
      'application/vnd.github.raw+json',
    );
    if (res.status === 404) return undefined;
    if (!res.ok) return this.fail(res, `reading ${path} at ${ref}`);
    return res.text();
  }

  /** Creates evalreplay's comment on the pull request, or updates the one it made before. */
  async upsertComment(repo: string, issue: number, body: string): Promise<'created' | 'updated'> {
    for (let page = 1; page <= 10; page++) {
      const res = await this.request(
        'GET',
        `/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`,
      );
      if (!res.ok) return this.fail(res, 'listing the pull request comments');
      const comments = (await res.json()) as { id: number; body?: string }[];
      const ours = comments.find((c) => c.body?.startsWith(MARKER));
      if (ours) {
        const patch = await this.request('PATCH', `/repos/${repo}/issues/comments/${ours.id}`, {
          body,
        });
        if (!patch.ok) return this.fail(patch, 'updating the comment');
        return 'updated';
      }
      if (comments.length < 100) break;
    }
    const post = await this.request('POST', `/repos/${repo}/issues/${issue}/comments`, { body });
    if (!post.ok) return this.fail(post, 'commenting on the pull request');
    return 'created';
  }
}
