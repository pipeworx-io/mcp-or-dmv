interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Oregon DMV MCP — live wait times at all 60 Oregon DMV field offices, plus the office
 * locator the same payload carries. Keyless.
 *
 * One pack per state agency: Oregon's grain is a live queue reading per field office —
 * how many customers are waiting and how long the average one waits — published by ODOT
 * DMV itself. That has nothing in common with California's ZIP × fuel registration
 * snapshot, so it gets its own tools with its own real arguments.
 *
 * Oregon and North Carolina are the only two states that publish a machine-readable live
 * DMV wait feed at all; every other state's is captcha-gated, blocked to bots, broken, or
 * only inside a phone app.
 *
 * Source (verified live 2026-07-29):
 *   https://dmv2u2.odot.state.or.us/waittimes/home/map — a server-rendered HTML page.
 *
 * There is no JSON endpoint behind that page: the office array is assigned to
 * `aveWaitModels` inside an inline <script>, and the /api paths one would guess at return
 * nothing. So this pack locates that identifier, brace-matches the array literal that
 * follows it, and JSON.parses it. That makes Oregon structurally more fragile than an API
 * — a template change can move the identifier — and the failure is reported as such
 * instead of as a parsing bug.
 *
 * Two upstream details are handled rather than passed on:
 *   1. Each office ships an `ipAddress` and `fieldOfficeMachine*` fields. Those are ODOT's
 *      internal queue-terminal plumbing and are dropped here rather than republished.
 *   2. `waitTimeEnabled` goes false outside business hours while `averageMinutesUntilServed`
 *      stays at -1 and `customersWaiting` at 0. Reporting that as a zero-minute wait would
 *      read as "walk right in", so those offices come back as status "not_reporting" with a
 *      null wait and a `note` explaining it.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-or-dmv/1.0 (+https://pipeworx.io)';
const MAP_PAGE = 'https://dmv2u2.odot.state.or.us/waittimes/home/map';
const SOURCE = 'Oregon DMV field-office wait times (dmv2u2.odot.state.or.us)';

/** The six regions ODOT groups its field offices into, for the `region` argument's hint. */
const REGIONS = ['Central Oregon', 'Eastern Oregon', 'Portland Area', 'Southern Oregon', 'The Coast', 'Willamette Valley'];

interface OrOffice {
  field_office_id: number | null;
  name: string;
  region: string | null;
  status: 'reporting' | 'not_reporting';
  wait_minutes: number | null;
  customers_waiting: number | null;
  open: boolean | null;
  appointment_only: boolean | null;
  closure_note: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  url: string | null;
}

/** ODOT ships bare 10-digit phone numbers; make them dialable-looking. */
function formatPhone(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits ? digits : null;
}

/**
 * Pull `aveWaitModels` out of the map page. Every failure mode gets its own message,
 * because "the page loaded but the array moved" and "the page is down" want different
 * responses from a caller.
 */
async function loadOffices(): Promise<OrOffice[]> {
  const html = await govFetchText(MAP_PAGE, {
    accept: 'text/html,application/xhtml+xml',
    userAgent: UA,
  });
  const marker = html.indexOf('aveWaitModels');
  if (marker === -1) {
    throw new Error('the Oregon wait-time page no longer contains the aveWaitModels office array');
  }
  const open = html.indexOf('[', marker);
  if (open === -1) {
    throw new Error('the Oregon wait-time page no longer contains the aveWaitModels office array');
  }
  let depth = 0;
  let end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('the Oregon wait-time page served a truncated office array');
  let rows: Array<Record<string, unknown>>;
  try {
    rows = JSON.parse(html.slice(open, end + 1)) as Array<Record<string, unknown>>;
  } catch {
    throw new Error('the Oregon wait-time page office array was not valid JSON — ODOT changed the page template');
  }
  return rows.map((r) => {
    const reporting = r.waitTimeEnabled === true;
    const mins = Number(r.averageMinutesUntilServed);
    return {
      field_office_id: govNumber(r.fieldOfficeId),
      name: String(r.fieldOfficeName ?? ''),
      region: typeof r.regionName === 'string' ? r.regionName : null,
      status: reporting ? 'reporting' : 'not_reporting',
      // -1 is ODOT's "unavailable" sentinel, and it survives waitTimeEnabled being true.
      wait_minutes: reporting && Number.isFinite(mins) && mins >= 0 ? mins : null,
      customers_waiting: reporting ? govNumber(r.customersWaiting) : null,
      open: typeof r.open === 'boolean' ? r.open : null,
      appointment_only: typeof r.appointmentOnly === 'boolean' ? r.appointmentOnly : null,
      closure_note: typeof r.closeDescription === 'string' && r.closeDescription.trim() ? r.closeDescription.trim() : null,
      address: typeof r.address === 'string' ? r.address : null,
      city: typeof r.city === 'string' ? r.city : null,
      zip: typeof r.zip === 'string' ? r.zip : null,
      phone: formatPhone(r.phone),
      latitude: govNumber(r.latitude),
      longitude: govNumber(r.longitude),
      url: typeof r.url === 'string' ? r.url : null,
    };
  });
}

const tools: McpToolExport['tools'] = [
  {
    name: 'or_dmv_wait_times',
    description:
      'Live wait times at Oregon DMV field offices, published by ODOT DMV itself: the current average minutes until served and how many customers are queued at each of the 60 offices statewide. Answers "how long is the wait at the Portland DMV", "which Oregon DMV office is fastest right now", "is the Salem DMV busy", or "shortest DMV line near Eugene". Oregon is one of only two states whose DMV publishes a live queue feed. Offices report only during business hours; outside them each comes back as not_reporting with a null wait, which is the agency switching the feed off rather than an office with no line.',
    inputSchema: {
      type: 'object',
      properties: {
        office: { type: 'string', description: 'Case-insensitive office-name substring, e.g. "Portland", "Beaverton", "Bend".' },
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Eugene", "Medford".' },
        region: { type: 'string', description: `ODOT region substring. One of ${REGIONS.join(', ')}.` },
        open_only: { type: ['boolean', 'string'], description: 'When true, keep only offices currently reporting a live wait.' },
        sort: { type: 'string', description: '"wait" ranks shortest reported wait first (reporting offices first); "name" (default) keeps the agency\'s own order.' },
        limit: { type: ['number', 'string'], description: 'Max offices to return (default 60, max 100).' },
      },
    },
  },
  {
    name: 'or_dmv_offices',
    description:
      'Find Oregon DMV field offices with street address, city, ZIP, phone number, latitude and longitude, and the ODOT region each belongs to. Covers all 60 DMV offices in Oregon, so it answers "DMV office in Eugene", "address and phone for the Bend DMV", "Oregon DMV offices near the coast", or "which DMV offices are in the Portland area". Each office also carries whether it is appointment-only and a link to its ODOT page. For the live queue length at these same offices use or_dmv_wait_times.',
    inputSchema: {
      type: 'object',
      properties: {
        office: { type: 'string', description: 'Case-insensitive office-name substring, e.g. "Gresham", "Albany".' },
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Portland", "Salem".' },
        zip: { type: 'string', description: 'Five-digit ZIP code, e.g. "97321". A prefix such as "973" also matches.' },
        region: { type: 'string', description: `ODOT region substring. One of ${REGIONS.join(', ')}.` },
        limit: { type: ['number', 'string'], description: 'Max offices to return (default 60, max 100).' },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

/** Shared filters; both tools search the same payload. */
function applyFilters(list: OrOffice[], args: Record<string, unknown>): { list: OrOffice[]; applied: Record<string, unknown> } {
  const office = govString(args, 'office');
  if (office) list = list.filter((o) => govContains(o.name, office));
  const city = govString(args, 'city');
  if (city) list = list.filter((o) => govContains(o.city, city));
  const zip = govString(args, 'zip');
  if (zip) list = list.filter((o) => (o.zip ?? '').startsWith(zip));
  const region = govString(args, 'region');
  if (region) list = list.filter((o) => govContains(o.region, region));
  return { list, applied: { office, city, zip, region } };
}

async function waitTimes(args: Record<string, unknown>): Promise<unknown> {
  const all = await loadOffices();
  const total = all.length;
  let { list, applied } = applyFilters(all, args);
  const openOnly = args.open_only === true || args.open_only === 'true';
  if (openOnly) list = list.filter((o) => o.status === 'reporting');

  if (!list.length) {
    const anyReporting = all.some((o) => o.status === 'reporting');
    return govNotFound(
      'no_matching_offices',
      openOnly && !anyReporting
        ? `No Oregon DMV office is reporting a wait right now — ODOT enables the live feed only during business hours. Call or_dmv_wait_times without open_only to see all ${total} offices, or or_dmv_offices for addresses and phone numbers.`
        : `No Oregon DMV office matched those filters. Drop the narrowest one, or call or_dmv_wait_times with no arguments for all ${total} offices. Regions are ${REGIONS.join(', ')}.`,
      { state: 'OR', source: SOURCE, filters_applied: { ...applied, open_only: openOnly }, offices_in_feed: total },
    );
  }

  if ((govString(args, 'sort') ?? '').toLowerCase() === 'wait') {
    list = [...list].sort((a, b) => {
      const ar = a.status === 'reporting';
      const br = b.status === 'reporting';
      if (ar !== br) return ar ? -1 : 1;
      return (a.wait_minutes ?? Number.MAX_SAFE_INTEGER) - (b.wait_minutes ?? Number.MAX_SAFE_INTEGER);
    });
  }

  const reporting = list.filter((o) => o.status === 'reporting');
  const waits = reporting.map((o) => o.wait_minutes).filter((v): v is number => v !== null);
  const limit = govLimit(args.limit, 60, 100);
  return {
    state: 'OR',
    source: SOURCE,
    grain: 'live queue reading per field office, as published by ODOT DMV at the moment of the call',
    office_count: list.length,
    offices_reporting: reporting.length,
    ...(waits.length
      ? {
          longest_wait_minutes: Math.max(...waits),
          shortest_wait_minutes: Math.min(...waits),
          customers_waiting_total: reporting.reduce((a, o) => a + (o.customers_waiting ?? 0), 0),
        }
      : {}),
    offices: list.slice(0, limit).map((o) => ({
      name: o.name,
      region: o.region,
      status: o.status,
      wait_minutes: o.wait_minutes,
      customers_waiting: o.customers_waiting,
      open: o.open,
      appointment_only: o.appointment_only,
      closure_note: o.closure_note,
      city: o.city,
      address: o.address,
      zip: o.zip,
      phone: o.phone,
      url: o.url,
    })),
    truncated: list.length > limit,
    note:
      reporting.length === 0
        ? 'No office is reporting right now: ODOT switches live wait reporting off outside business hours, so wait_minutes is null rather than zero. Addresses and phone numbers are still current — or_dmv_offices returns them with coordinates.'
        : 'Offices with status not_reporting have live reporting switched off (typically outside business hours), so their wait_minutes is null rather than zero.',
  };
}

async function offices(args: Record<string, unknown>): Promise<unknown> {
  const all = await loadOffices();
  const total = all.length;
  const { list, applied } = applyFilters(all, args);
  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      `No Oregon DMV office matched those filters. Drop the narrowest one — \`zip\` and \`region\` are the usual culprits — or call or_dmv_offices with no arguments for the full list of ${total}. Regions are ${REGIONS.join(', ')}.`,
      { state: 'OR', source: SOURCE, filters_applied: applied, offices_in_feed: total },
    );
  }
  const limit = govLimit(args.limit, 60, 100);
  return {
    state: 'OR',
    source: SOURCE,
    grain: 'one row per Oregon DMV field office, with the location details ODOT publishes',
    office_count: list.length,
    offices: list.slice(0, limit).map((o) => ({
      state: 'OR',
      office_type: 'DMV field office',
      name: o.name,
      region: o.region,
      address: o.address,
      city: o.city,
      zip: o.zip,
      phone: o.phone,
      latitude: o.latitude,
      longitude: o.longitude,
      appointment_only: o.appointment_only,
      closure_note: o.closure_note,
      url: o.url,
      field_office_id: o.field_office_id,
    })),
    truncated: list.length > limit,
    note: 'Locations come from the same ODOT wait-time page that serves live queue lengths. For the current wait at these offices use or_dmv_wait_times.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'or_dmv_wait_times': return await waitTimes(args);
      case 'or_dmv_offices': return await offices(args);
      default:
        return govNotFound('unknown_tool', `or-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `or-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'The Oregon DMV wait-time page timed out. Retry once — it is a single page fetch, so a stall is usually transient.'
        : /aveWaitModels|template|truncated|valid JSON/i.test(message)
          ? 'Oregon publishes wait times only as an array embedded in an HTML page, with no JSON endpoint behind it, so an ODOT template change breaks extraction until this pack is updated. nc_dmv_wait_times is the other state feed that publishes live DMV waits.'
          : 'ODOT refused the request or served an error page. Retry once; if it persists, nc_dmv_wait_times is the other state feed that publishes live DMV waits.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
