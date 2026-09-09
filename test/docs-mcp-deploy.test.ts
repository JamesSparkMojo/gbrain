/**
 * #4500: docs/mcp/DEPLOY.md + ALTERNATIVES.md must document the tailnet/LAN-only
 * `serve --http` shape and the MCP SDK's "Issuer URL must be HTTPS" exit.
 *
 * The HTTPS-issuer check lives in @modelcontextprotocol/sdk (checkIssuerUrl), so
 * gbrain cannot soften it; the only fix is telling operators which shapes work
 * (Tailscale Serve, plain-HTTP bearer-only without --public-url) and naming the
 * SDK's own opt-in. Doc-text pins, same precedent as docs-cli-commands.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

const ROOT = dirname(import.meta.dir);
const deploy = readFileSync(join(ROOT, 'docs/mcp/DEPLOY.md'), 'utf8');
const alternatives = readFileSync(join(ROOT, 'docs/mcp/ALTERNATIVES.md'), 'utf8');

describe('DEPLOY.md documents the tailnet/LAN-only serve --http shape (#4500)', () => {
  test('troubleshooting names the SDK issuer error and its opt-in', () => {
    const troubleshooting = deploy.slice(deploy.indexOf('## Troubleshooting'));
    expect(troubleshooting).toContain('Issuer URL must be HTTPS');
    expect(troubleshooting).toContain('MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL');
  });

  test('HTTP section states --source-guard is stdio-only and points at the CORS allowlist', () => {
    expect(deploy).toContain('--source-guard');
    expect(deploy).toContain('GBRAIN_HTTP_CORS_ORIGIN');
  });

  test('ALTERNATIVES.md distinguishes tailnet-only Serve from public Funnel', () => {
    expect(alternatives).toContain('tailscale serve');
    expect(alternatives).toContain('tailscale funnel');
  });
});
