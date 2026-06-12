import { validPayload, type Payload } from './schema.js';

interface Env {
  DB: D1Database;
  USAGE: AnalyticsEngineDataset;
  INGEST_RATE_LIMITER: RateLimit;
  ASSETS: Fetcher;
  GITHUB_REPOSITORY: string;
  NPM_PACKAGE: string;
  GITHUB_TOKEN?: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/ingest' && request.method === 'POST') return ingest(request, env);
    if (url.pathname === '/api/dashboard' && request.method === 'GET') return dashboard(env);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, day: new Date().toISOString().slice(0, 10) });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(collectEcosystem(env));
  },
} satisfies ExportedHandler<Env>;

async function ingest(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 32_768) return json({ error: 'payload_too_large' }, 413);

  let payload: Payload;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 32_768) {
      return json({ error: 'payload_too_large' }, 413);
    }
    payload = JSON.parse(text) as Payload;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!validPayload(payload)) return json({ error: 'invalid_payload' }, 400);

  const limited = await env.INGEST_RATE_LIMITER.limit({ key: payload.monthly_install_id });
  if (!limited.success) return json({ error: 'rate_limited' }, 429);

  const receipt = await env.DB.prepare(
    'INSERT OR IGNORE INTO ingest_receipts(day, monthly_install_id) VALUES (?, ?)',
  )
    .bind(payload.day, payload.monthly_install_id)
    .run();
  if ((receipt.meta.changes ?? 0) === 0) return json({ ok: true, duplicate: true }, 202);

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT OR IGNORE INTO install_activity(day, monthly_install_id) VALUES (?, ?)',
    ).bind(payload.day, payload.monthly_install_id),
  ];

  for (const count of payload.counts) {
    env.USAGE.writeDataPoint({
      blobs: [
        payload.day,
        payload.package_version,
        payload.surface,
        count.network,
        count.operation,
        count.outcome,
      ],
      doubles: [count.count],
      indexes: [payload.monthly_install_id],
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO usage_daily(day, package_version, surface, network, operation, outcome, count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, package_version, surface, network, operation, outcome)
         DO UPDATE SET count = count + excluded.count`,
      ).bind(
        payload.day,
        payload.package_version,
        payload.surface,
        count.network,
        count.operation,
        count.outcome,
        count.count,
      ),
    );
  }
  await env.DB.batch(statements);
  return json({ ok: true }, 202);
}

async function collectEcosystem(env: Env): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const metrics: Array<[string, string, number]> = [];
  const npmBase = `https://api.npmjs.org/downloads/point`;
  for (const [period, metric] of [
    ['last-day', 'npm_downloads_day'],
    ['last-week', 'npm_downloads_7d'],
    ['last-month', 'npm_downloads_30d'],
  ] as const) {
    const data = await fetchJson<{ downloads?: number }>(`${npmBase}/${period}/${env.NPM_PACKAGE}`);
    if (typeof data?.downloads === 'number') metrics.push([metric, '', data.downloads]);
  }

  const metadata = await fetchJson<{ time?: Record<string, string> }>(
    `https://registry.npmjs.org/${env.NPM_PACKAGE}`,
  );
  const versions = Object.entries(metadata?.time ?? {}).filter(
    ([version]) => !['created', 'modified'].includes(version),
  );

  const headers: HeadersInit = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'affiliate-mcp-telemetry',
    ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };
  const repo = await fetchJson<{ stargazers_count?: number; forks_count?: number }>(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`,
    headers,
  );
  if (typeof repo?.stargazers_count === 'number')
    metrics.push(['github_stars', '', repo.stargazers_count]);
  if (typeof repo?.forks_count === 'number') metrics.push(['github_forks', '', repo.forks_count]);

  const releases = await fetchJson<
    Array<{ assets?: Array<{ name?: string; download_count?: number }> }>
  >(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/releases?per_page=100`, headers);
  for (const release of releases ?? []) {
    for (const asset of release.assets ?? []) {
      if (
        asset.name &&
        typeof asset.download_count === 'number' &&
        /\.(mcpb|dmg|zip)$/i.test(asset.name)
      ) {
        metrics.push(['github_asset_downloads', asset.name, asset.download_count]);
      }
    }
  }

  if (env.GITHUB_TOKEN) {
    for (const [endpoint, metric] of [
      ['clones', 'github_clones'],
      ['views', 'github_views'],
    ] as const) {
      const traffic = await fetchJson<{ count?: number; uniques?: number }>(
        `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/traffic/${endpoint}`,
        headers,
      );
      if (typeof traffic?.count === 'number') metrics.push([metric, 'total', traffic.count]);
      if (typeof traffic?.uniques === 'number') metrics.push([metric, 'unique', traffic.uniques]);
    }
  }

  const statements = metrics.map(([metric, dimension, value]) =>
    env.DB.prepare(
      `INSERT INTO ecosystem_daily(day, metric, dimension, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, metric, dimension) DO UPDATE SET value = excluded.value`,
    ).bind(day, metric, dimension, value),
  );
  statements.push(
    ...versions.map(([version, publishedAt]) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO package_versions(version, published_at) VALUES (?, ?)',
      ).bind(version, publishedAt),
    ),
    env.DB.prepare("DELETE FROM install_activity WHERE day < date('now', '-35 days')"),
    env.DB.prepare("DELETE FROM ingest_receipts WHERE day < date('now', '-35 days')"),
  );
  await env.DB.batch(statements);
}

async function dashboard(env: Env): Promise<Response> {
  const [ecosystem, usage, active] = await Promise.all([
    env.DB.prepare(
      'SELECT day, metric, dimension, value FROM ecosystem_daily ORDER BY day DESC, metric LIMIT 500',
    ).all(),
    env.DB.prepare(
      `SELECT package_version, surface, network, operation, outcome, SUM(count) AS count
       FROM usage_daily WHERE day >= date('now', '-30 days')
       GROUP BY package_version, surface, network, operation, outcome
       ORDER BY count DESC LIMIT 200`,
    ).all(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT monthly_install_id) AS monthly_active_installs
       FROM install_activity WHERE day >= date('now', '-30 days')`,
    ).first(),
  ]);
  return json({ ecosystem: ecosystem.results, usage: usage.results, reach: active });
}

async function fetchJson<T>(url: string, headers?: HeadersInit): Promise<T | undefined> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
