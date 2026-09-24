/**
 * Row-level security: resolve external_value (the per-viewer RLS key) SERVER-SIDE.
 *
 * external_value is surfaced inside the dashboard's dataset SQL as the global
 * variable __aibi_external_value. The whole security model rests on it being
 * decided HERE, from the authenticated viewer, never taken from a client path or
 * request body (which the viewer can change).
 *
 * Airport resolution is GROUP-BASED: each airport has a Databricks group, and a
 * viewer's airport is whichever airport group they belong to. To onboard a user
 * you just add them to the group - no app change, no redeploy, no email lists.
 *
 * Convention: a group named "<prefix><code>" grants airport <code>, e.g.
 *   airport-fra -> FRA,  airport-bsb -> BSB      (prefix defaults to "airport-")
 * Members of an admin group (default "airport-admin") see ALL airports, and a
 * viewer in several airport groups sees all of them (multi-airport). The prefix,
 * admin groups and any non-convention overrides live in server/airports.json
 * (config, not code); env vars override it per deploy.
 *
 * Ported from the simple-embed-test prototype; the token exchange itself lives in
 * ./embed.js, which this module reuses for the SP OAuth token + workspace host.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOAuthToken, INSTANCE_URL, WORKSPACE_ID } from './embed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Group->airport mapping is CONFIG, not code: it lives in server/airports.json so
// airports and admin groups change without editing this file. With the
// "<prefix><code>" naming convention you list nothing; env vars still override the
// file per deploy. A missing/invalid file falls back to safe defaults.
function loadAirportConfig() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(__dirname, 'airports.json'), 'utf8'));
    return {
      groupPrefix: cfg.groupPrefix,
      adminGroups: Array.isArray(cfg.adminGroups) ? cfg.adminGroups : [],
      groups: cfg.groups && typeof cfg.groups === 'object' ? cfg.groups : {},
    };
  } catch {
    return { groupPrefix: undefined, adminGroups: [], groups: {} };
  }
}
const FILE_CFG = loadAirportConfig();

// Parse "grp:CODE,grp2:CODE2" into a lowercased-key -> code map.
function parseGroupMap(str) {
  return Object.fromEntries(
    String(str || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.lastIndexOf(':');
        return i > 0 ? [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()] : null;
      })
      .filter(Boolean)
  );
}

const AIRPORT_GROUP_PREFIX = (process.env.AIRPORT_GROUP_PREFIX || FILE_CFG.groupPrefix || 'airport-').toLowerCase();

// Members of an admin group see ALL airports (external_value = '' -> the dataset's
// "all rows" branch). Defaults to "airport-admin" when nothing is configured.
const _envAdminGroups = String(process.env.ADMIN_GROUPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Env replaces the file list per deploy; fall back to the file, then a default.
const ADMIN_GROUPS = new Set(
  (_envAdminGroups.length ? _envAdminGroups : FILE_CFG.adminGroups).map((g) => g.toLowerCase())
);
if (ADMIN_GROUPS.size === 0) ADMIN_GROUPS.add('airport-admin');

// Explicit overrides for groups that do NOT follow the convention. The file
// provides the base map; GROUP_AIRPORT_MAP env overrides it per deploy.
const GROUP_AIRPORT_MAP = {
  ...Object.fromEntries(
    Object.entries(FILE_CFG.groups).map(([k, v]) => [k.toLowerCase().trim(), String(v).trim()])
  ),
  ...parseGroupMap(process.env.GROUP_AIRPORT_MAP),
};

// TEST ESCAPE HATCH ONLY. When "true", a client-supplied airport (from the embed
// request body) is honored so you can switch viewers without real SSO. This is
// the bypassable path - it MUST be false/unset in production.
export const ALLOW_CLIENT_AIRPORT = /^(1|true|yes)$/i.test(process.env.ALLOW_CLIENT_AIRPORT || '');

// The dataset SQL shows ALL rows when __aibi_external_value is empty (the
// `nullif(...) IS NULL` branch). So a viewer we can't scope must NOT get an empty
// value, or they would see every airport. We send a sentinel that matches no
// airport -> zero rows (fail CLOSED). Set FAIL_OPEN=true to deliberately show all
// rows to unscoped viewers (admin/demo only).
const NO_ACCESS_SENTINEL = '__no_access__';
const FAIL_OPEN = /^(1|true|yes)$/i.test(process.env.FAIL_OPEN || '');
// A static EXTERNAL_VALUE default would apply to EVERY unscoped viewer (silent
// over-share), so it is honored only when explicitly opted in. Otherwise unscoped
// viewers fail closed.
const ALLOW_DEFAULT_EXTERNAL_VALUE = /^(1|true|yes)$/i.test(process.env.ALLOW_DEFAULT_EXTERNAL_VALUE || '');

// The Databricks Apps runtime injects the authenticated viewer's identity as
// x-forwarded-* headers; the viewer cannot forge these.
export function viewerIdentity(req) {
  return (
    req.headers['x-forwarded-email'] ||
    req.headers['x-forwarded-preferred-username'] ||
    req.headers['x-forwarded-user'] ||
    ''
  )
    .toString()
    .trim();
}

// Map a viewer's group names -> the set of airport codes they may see. Pure and
// unit-testable. Per group, an explicit GROUP_AIRPORT_MAP entry wins, else the
// "<prefix><code>" naming convention. Returns a deduped, sorted array: a viewer
// can belong to several airport groups (multi-airport access), and sorting keeps
// the resulting external_value deterministic regardless of SCIM group order.
export function airportsFromGroups(groupNames) {
  const names = (groupNames || []).map((g) => String(g).trim()).filter(Boolean);
  const codes = new Set();
  for (const g of names) {
    const key = g.toLowerCase();
    if (ADMIN_GROUPS.has(key)) continue; // admin group is not an airport code
    const mapped = GROUP_AIRPORT_MAP[key];
    if (mapped) {
      codes.add(mapped);
      continue;
    }
    if (key.startsWith(AIRPORT_GROUP_PREFIX)) {
      const code = key.slice(AIRPORT_GROUP_PREFIX.length).trim();
      if (code) codes.add(code.toUpperCase());
    }
  }
  return [...codes].sort();
}

// True if any of the viewer's groups is an admin group (sees all airports).
export function isAdminFromGroups(groupNames) {
  return (groupNames || []).some((g) => ADMIN_GROUPS.has(String(g).trim().toLowerCase()));
}

// The Databricks Apps runtime may forward the viewer's own OAuth token.
function forwardedViewerToken(req) {
  return (req && (req.headers['x-forwarded-access-token'] || req.headers['x-forwarded-token'])) || '';
}

// Only build a SCIM filter from a value that looks like a real userName/email.
// Rejects quotes, backslashes and whitespace - the SCIM filter-injection vectors.
function isSafeUserName(email) {
  return (
    typeof email === 'string' &&
    email.length > 0 &&
    email.length <= 320 &&
    email.includes('@') &&
    !/[\s"\\]/.test(email)
  );
}

// Belt-and-suspenders: escape SCIM string-literal specials even after validation.
function scimEscape(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

// Cache key must be unique per viewer. With no email we key on a hash of the
// forwarded token (never a shared constant), so two token-only viewers cannot
// collide onto one another's cached groups.
function cacheKeyFor(email, req) {
  if (email) return `email:${email.toLowerCase()}`;
  const fwd = forwardedViewerToken(req);
  if (fwd) return 'tok:' + createHash('sha256').update(fwd).digest('hex').slice(0, 16);
  return 'anon';
}

// Look up a viewer's Databricks groups. Two mechanisms, best first:
//   1. the viewer's OWN forwarded token -> GET /scim/v2/Me  (no admin needed,
//      true viewer identity). Used when the Apps runtime forwards the token.
//   2. the app SP -> GET /scim/v2/Users?filter=userName eq ...  (fallback;
//      needs the SP to be allowed to read users - workspace admin / SCIM read).
// Result cached briefly so we don't hit SCIM on every token mint.
const _groupCache = new Map(); // email -> { at, groups }
const GROUP_CACHE_MS = 5 * 60 * 1000;
export async function getViewerGroups(email, req) {
  const cacheKey = cacheKeyFor(email, req);
  const hit = _groupCache.get(cacheKey);
  if (hit && Date.now() - hit.at < GROUP_CACHE_MS) return hit.groups;

  let groups = null;
  // 1) viewer's forwarded token -> /Me
  const fwd = forwardedViewerToken(req);
  if (fwd) {
    const url = new URL(`${INSTANCE_URL}/api/2.0/preview/scim/v2/Me`);
    if (WORKSPACE_ID) url.searchParams.set('o', WORKSPACE_ID);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${fwd}` } });
    if (resp.ok) {
      const u = await resp.json();
      groups = (u.groups || []).map((g) => g.display).filter(Boolean);
    }
    // if /Me fails we fall through to the SP lookup
  }
  // 2) SP SCIM Users lookup by email
  if (groups === null) {
    if (!email) return [];
    if (!isSafeUserName(email)) return []; // suspicious identity -> no groups -> fail closed
    const oauth = await getOAuthToken();
    const url = new URL(`${INSTANCE_URL}/api/2.0/preview/scim/v2/Users`);
    url.searchParams.set('filter', `userName eq "${scimEscape(email)}"`);
    url.searchParams.set('attributes', 'userName,groups');
    if (WORKSPACE_ID) url.searchParams.set('o', WORKSPACE_ID);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${oauth}` } });
    if (!resp.ok) throw new Error(`SCIM user lookup (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    const user = (data.Resources || [])[0];
    groups = (user?.groups || []).map((g) => g.display).filter(Boolean);
  }
  _groupCache.set(cacheKey, { at: Date.now(), groups });
  return groups;
}

// Decide the external_value for this request. Returns { value, source }.
// Precedence: viewer's airport GROUP -> (test flag) client value -> env default
// -> fail closed.
export async function resolveExternalValue(req, clientValue) {
  const email = viewerIdentity(req);
  let lookupErr = null;
  if (email) {
    try {
      const groups = await getViewerGroups(email, req);
      // Admins see everything: empty value -> the dataset's "all rows" branch.
      if (isAdminFromGroups(groups)) return { value: '', source: `admin:${email}` };
      // A viewer may belong to several airport groups; the RLS key is the
      // comma-joined set of their codes (e.g. "FRA,BSB"). The dataset SQL must
      // treat __aibi_external_value as a membership list, not a single equals.
      const airports = airportsFromGroups(groups);
      if (airports.length) return { value: airports.join(','), source: `group:${email}` };
    } catch (e) {
      lookupErr = e.message; // fall through to the fallback chain below
    }
  }
  if (ALLOW_CLIENT_AIRPORT && clientValue) {
    return { value: String(clientValue).trim(), source: 'client(test-flag)' };
  }
  if (ALLOW_DEFAULT_EXTERNAL_VALUE && process.env.EXTERNAL_VALUE) {
    return { value: process.env.EXTERNAL_VALUE.trim(), source: 'default-env' };
  }
  // No airport group for this viewer: fail closed (no rows) unless FAIL_OPEN is set.
  let who = email ? `no-airport-group(${email})` : 'anonymous';
  if (lookupErr) who = `group-lookup-failed(${email}): ${lookupErr}`;
  if (FAIL_OPEN) return { value: '', source: `${who}:fail-open` };
  return { value: NO_ACCESS_SENTINEL, source: `${who}:fail-closed` };
}
