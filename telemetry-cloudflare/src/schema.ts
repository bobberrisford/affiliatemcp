export type Outcome =
  | 'success'
  | 'auth_error'
  | 'rate_limit'
  | 'config_error'
  | 'not_implemented'
  | 'timeout'
  | 'circuit_open'
  | 'network_unavailable'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'upstream_error'
  | 'internal_error'
  | 'other_error';
export type Surface = 'npm' | 'mcpb' | 'desktop-bundle' | 'unknown';

export interface Count {
  network: string;
  operation: string;
  outcome: Outcome;
  count: number;
}

export interface Payload {
  schema_version: 1 | 2;
  day: string;
  monthly_install_id: string;
  package_version: string;
  surface: Surface;
  counts: Count[];
}

// Schema v1 clients remain in the field; each version accepts exactly its own
// outcome vocabulary so an unexpected value is rejected rather than stored.
const OUTCOMES_V1 = new Set<Outcome>([
  'success',
  'auth_error',
  'rate_limit',
  'config_error',
  'upstream_error',
  'other_error',
]);
const OUTCOMES_V2 = new Set<Outcome>([
  ...OUTCOMES_V1,
  'not_implemented',
  'timeout',
  'circuit_open',
  'network_unavailable',
  'upstream_4xx',
  'upstream_5xx',
  'internal_error',
]);
const SURFACES = new Set<Surface>(['npm', 'mcpb', 'desktop-bundle', 'unknown']);
const DIMENSION = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

export function validPayload(value: unknown): value is Payload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<Payload> & Record<string, unknown>;
  if (
    Object.keys(p).some(
      (key) =>
        ![
          'schema_version',
          'day',
          'monthly_install_id',
          'package_version',
          'surface',
          'counts',
        ].includes(key),
    )
  ) {
    return false;
  }
  if (
    (p.schema_version !== 1 && p.schema_version !== 2) ||
    typeof p.day !== 'string' ||
    !DAY.test(p.day) ||
    !isRealDay(p.day) ||
    typeof p.monthly_install_id !== 'string' ||
    !UUID.test(p.monthly_install_id) ||
    typeof p.package_version !== 'string' ||
    !VERSION.test(p.package_version) ||
    typeof p.surface !== 'string' ||
    !SURFACES.has(p.surface as Surface) ||
    !Array.isArray(p.counts) ||
    p.counts.length < 1 ||
    p.counts.length > 500
  ) {
    return false;
  }
  const outcomes = p.schema_version === 1 ? OUTCOMES_V1 : OUTCOMES_V2;
  return p.counts.every((count) => {
    if (!count || typeof count !== 'object') return false;
    const c = count as Partial<Count> & Record<string, unknown>;
    return (
      Object.keys(c).every((key) => ['network', 'operation', 'outcome', 'count'].includes(key)) &&
      typeof c.network === 'string' &&
      DIMENSION.test(c.network) &&
      typeof c.operation === 'string' &&
      DIMENSION.test(c.operation) &&
      typeof c.outcome === 'string' &&
      outcomes.has(c.outcome as Outcome) &&
      Number.isSafeInteger(c.count) &&
      Number(c.count) >= 1 &&
      Number(c.count) <= 1_000_000
    );
  });
}

function isRealDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}
