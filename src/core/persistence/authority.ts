import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { slugUnderBoundPrefixes, matchesSlugAllowList } from '../ops/context.ts';
import { hasScope } from '../scope.ts';
import { coerceLegacyPermissions, normalizeTokenScopes, parseLegacyTokenScope, parseTakesHoldersAllowList } from '../legacy-token-scope.ts';
import { readLocalWriter, currentVerifiedLocalWriter, verifyLocalWriter, type LocalGrant } from './identity.ts';
import type { Principal, SqlEngine, WriteAuthority, WriteRequest } from './model.ts';

function deny(message: string): never { throw new OperationError('permission_denied', message, 'Inspect the current writer registration and source/operation grants.'); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string'); }
function operationAllowed(ops: unknown, operation: string): boolean { return ops == null || strings(ops) && ops.includes(operation); }
function prefixAllowed(prefixes: string[] | null | undefined, slug: string): boolean {
  return prefixes == null || slugUnderBoundPrefixes(prefixes, slug);
}
export async function submissionAuthority(ctx: OperationContext, operation: string, sourceId: string, sourceIncarnation: string, slug: string): Promise<WriteAuthority> {
  if (ctx.auth?.fenceProjectionDegraded || ctx.auth?.grantProjectionDegraded) deny('The grant projection is incomplete.');
  let principal: Principal;
  let localGrant: LocalGrant | undefined;
  if (ctx.auth?.principal) principal = { ...ctx.auth.principal };
  else {
    const verified = currentVerifiedLocalWriter() ?? await verifyLocalWriter(ctx.engine,
      await readLocalWriter(ctx.engine, ctx.remote === false ? 'cli' : 'stdio'));
    if (verified.remote !== (ctx.remote !== false)) deny('The local trust lane does not match this transport.');
    principal = verified.principal;
    localGrant = verified.grant;
    if (!localGrant.sourceIds.includes('*') && !localGrant.sourceIds.includes(sourceId)) deny('The local grant excludes this source.');
  }
  const a: WriteAuthority = {
    version: 1, principal, remote: ctx.remote !== false, sourceId, sourceIncarnation,
    takesHolders: ctx.remote === false ? null : [...(ctx.takesHoldersAllowList ?? ['world'])],
    scopes: [...(ctx.auth?.scopes ?? localGrant?.scopes ?? [])],
    operations: ctx.auth?.allowedOperations ? [...ctx.auth.allowedOperations] : localGrant?.operations ?? null,
    slugPrefixes: ctx.auth?.boundSlugPrefixes ? [...ctx.auth.boundSlugPrefixes] : localGrant?.slugPrefixes ?? null,
    ...(ctx.viaSubagent && ctx.auth ? { delegated: true, delegatedPrefixes: ctx.allowedSlugPrefixes ? [...ctx.allowedSlugPrefixes] : [] } : {}),
  };
  if (ctx.auth?.sourceId != null && ctx.auth.sourceId !== sourceId) deny('The source is outside this writer grant.');
  if (!prefixAllowed(a.slugPrefixes, slug)) deny('The target is outside this writer grant.');
  await authorizeWrite(ctx.engine, a, operation, slug);
  return a;
}

/** Caller holds source guards first. FOR SHARE serializes publication against revocation. */
export async function authorizeWrite(engine: SqlEngine, a: WriteAuthority, operation: string, slug: string, lock = false): Promise<void> {
  if (a.version !== 1 || !a.principal || !a.sourceId || !a.sourceIncarnation) deny('Missing durable write authority.');
  if (!hasScope(a.scopes, a.delegated ? 'agent' : 'write') || !operationAllowed(a.operations, operation) || !prefixAllowed(a.slugPrefixes, slug)) deny('The operation exceeds its original accepted grant.');
  if (a.delegated && (!a.delegatedPrefixes?.length || !matchesSlugAllowList(slug, a.delegatedPrefixes))) deny('The target exceeds the accepted delegated namespace.');
  const suffix = lock ? ' FOR SHARE' : '';
  if (a.principal.kind === 'oauth_client') {
    const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT deleted_at,scope,source_id,allowed_operations,
      bound_slug_prefixes,bound_tools,delegated_slug_prefixes FROM oauth_clients WHERE client_id=$1${suffix}`, [a.principal.id]);
    if (!row || row.deleted_at != null || row.source_id !== a.sourceId) deny('The owning OAuth client is revoked or its source changed.');
    const scopes = typeof row.scope === 'string' ? row.scope.split(/\s+/) : [];
    if (!hasScope(scopes, a.delegated ? 'agent' : 'write')) deny('The current OAuth grant no longer permits this write.');
    if (a.delegated) {
      if (!strings(row.bound_tools) || !row.bound_tools.some(t => t.replace(/^(?:brain_|mcp__gbrain__)/, '') === operation)) deny('The delegated tool was removed from the current grant.');
      if (!strings(row.delegated_slug_prefixes) || !matchesSlugAllowList(slug, row.delegated_slug_prefixes)) deny('The delegated namespace was narrowed.');
    } else if (!operationAllowed(row.allowed_operations, operation) ||
      (row.bound_slug_prefixes != null && (!strings(row.bound_slug_prefixes) || !prefixAllowed(row.bound_slug_prefixes, slug)))) deny('The current operation or slug grant excludes this write.');
    return;
  }
  if (a.principal.kind === 'legacy_token') {
    const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT revoked_at,scopes,permissions FROM access_tokens WHERE id=$1${suffix}`, [a.principal.id]);
    if (!row || row.revoked_at != null) deny('The owning token is revoked.');
    const permissions = coerceLegacyPermissions(row.permissions);
    if (row.permissions != null && !permissions) deny('The current legacy grant is malformed.');
    if (!hasScope(normalizeTokenScopes(row.scopes) ?? ['read', 'write', 'admin'], 'write') ||
      parseLegacyTokenScope(permissions?.source_id).sourceId !== a.sourceId) deny('The current token no longer permits this source write.');
    return;
  }
  if (a.principal.kind === 'local_cli' || a.principal.kind === 'local_stdio') {
    const [row] = await engine.executeRaw<{ lane: string; revoked_at: unknown; grant_ceiling: LocalGrant }>(
      `SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid${suffix}`, [a.principal.id]);
    const lane = a.principal.kind === 'local_cli' ? 'cli' : 'stdio';
    if (!row || row.revoked_at != null || row.lane !== lane || a.remote !== (lane === 'stdio')) deny('The local writer is revoked or its trust lane changed.');
    const g = row.grant_ceiling;
    if (!g || !strings(g.sourceIds) || !(g.sourceIds.includes('*') || g.sourceIds.includes(a.sourceId)) ||
      !hasScope(g.scopes, 'write') || !operationAllowed(g.operations, operation) || !prefixAllowed(g.slugPrefixes, slug)) deny('The current local writer grant excludes this request.');
    return;
  }
  deny('Application authority is unavailable through submitted write requests.');
}
export async function authorizeStoredRequest(engine: SqlEngine, row: WriteRequest, lock = false): Promise<void> {
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>(
    `SELECT incarnation,archived FROM sources WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [row.source_id]);
  if (!source || source.archived || source.incarnation !== row.source_incarnation) throw new OperationError('source_changed', 'The accepted source is no longer active.');
  await authorizeWrite(engine, row.authority, row.operation, row.slug, lock);
}
export async function ownRequestAccessible(ctx: OperationContext, row: WriteRequest): Promise<boolean> {
  try {
    const auth = await submissionAuthority(ctx, row.operation, row.source_id, row.source_incarnation, row.slug);
    if (auth.principal.kind !== row.principal_kind || auth.principal.id !== row.principal_id) return false;
    await authorizeStoredRequest(ctx.engine, row);
    return true;
  } catch (error) {
    if (error instanceof OperationError && ['permission_denied','source_changed','writer_registration_required'].includes(error.code)) return false;
    throw error;
  }
}


/** Caller holds the same principal guard as revocation/rescoping. */
export async function authorizeTakeHolder(engine: SqlEngine, authority: WriteAuthority, holder: string): Promise<void> {
  if (!authority.remote) return;
  if (!(authority.takesHolders ?? ['world']).includes(holder)) deny('The take holder exceeds the original grant.');
  let current = ['world'];
  if (authority.principal.kind === 'legacy_token') {
    const [row] = await engine.executeRaw<{ permissions: unknown }>('SELECT permissions FROM access_tokens WHERE id=$1 AND revoked_at IS NULL', [authority.principal.id]);
    if (!row) deny('The owning token is revoked.');
    current = parseTakesHoldersAllowList(coerceLegacyPermissions(row.permissions)?.takes_holders) ?? ['world'];
  }
  if (!current.includes(holder)) deny('The current holder grant excludes this write.');
}
