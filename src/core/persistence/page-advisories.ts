import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { writerLintForPutPage } from '../output/post-write.ts';
import type { WriteRequest } from './model.ts';

const LINT_MESSAGES: Record<string,string> = { citation:'Paragraph has no citation marker.',
  link:'A link target is unavailable.', 'back-link':'A reverse link is missing.', 'triple-hr':'An ambiguous timeline separator was found.' };

export function remoteLinkHint(row: WriteRequest): Record<string, unknown> {
  return row.authority.remote && !row.authority.autoLinkTrusted ? { auto_links: { skipped: 'remote',
    hint: 'Body wikilinks are saved as text but NOT reconciled into the graph. Use a trusted local capture or put_page for automatic link extraction.' } } : {};
}
/** Optional lint reads are outside publication locks; its bounded result is retained in the receipt. */
export async function preparePageAdvisories(engine: BrainEngine, row: WriteRequest, page: ParsedPage) {
  const visible = row.authority.remote ? { ...page, compiled_truth: sanitizeRemoteBody(page.compiled_truth),
    timeline: sanitizeRemoteBody(page.timeline ?? '') } : page;
  const lint = await writerLintForPutPage(engine, row.slug, { sourceId: row.source_id, noLog: true, page: visible });
  const sanitized = lint && 'top_findings' in lint ? { ...lint,
    top_findings: lint.top_findings.map(finding => ({ ...finding, message: LINT_MESSAGES[finding.validator] ?? `${finding.validator} validation finding.` })) } : lint;
  return { ...remoteLinkHint(row), ...(sanitized ? { writer_lint: sanitized } : {}) };
}
