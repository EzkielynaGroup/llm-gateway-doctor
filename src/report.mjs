// Turns run results into a redacted report object, then renders table / JSON / HTML / SVG badge.
import { VERSION, escapeHtml, truncate, safeUrl } from './util.mjs';

const SAFE_HEADERS = new Set(['content-type', 'accept', 'user-agent', 'anthropic-version', 'anthropic-beta']);
const EXCERPT = 2000;

function excerptExchange(ex, redact) {
  const out = {};
  const req = ex.request || {};
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) headers[k] = SAFE_HEADERS.has(k.toLowerCase()) ? v : '[REDACTED]';
  out.request = {
    method: req.method,
    url: safeUrl(req.url),
    headers,
    body: req.body === undefined ? undefined : truncate(redact(JSON.stringify(req.body, null, 2)), EXCERPT),
  };
  if (ex.error) out.error = redact(ex.error);
  if (ex.response) {
    out.response = {
      status: ex.response.status,
      content_type: ex.response.headers['content-type'] || null,
      body: truncate(redact(ex.response.text), EXCERPT),
    };
  }
  out.duration_ms = ex.duration_ms;
  return out;
}

/** Build the report object. Every string that came from the network passes through `redact`. */
export function buildReport({ results, summary, target, plan, redact }) {
  const report = {
    tool: 'llm-gateway-doctor',
    version: VERSION,
    generated_at: new Date().toISOString(),
    target: { base_url: safeUrl(target.baseUrl), model: target.model, profile: target.profile },
    plan: { requests: plan.requests, est_input_tokens: plan.inputTokens, max_output_tokens: plan.outputTokens },
    summary,
    checks: results.map((r) => {
      const c = {
        id: r.id,
        title: r.title,
        severity: r.severity,
        status: r.status,
        tags: r.tags,
        problems: r.problems.map((p) => redact(p)),
        notes: r.notes.map((n) => redact(n)),
        duration_ms: r.duration_ms,
      };
      if (r.reused) c.reuses = r.reused;
      if (r.status === 'fail' || r.status === 'warn') {
        c.fix_hint = r.fix_hint;
        c.exchanges = r.exchanges.map((e) => ({ label: e.label, ...excerptExchange(e.exchange, redact) }));
      }
      return c;
    }),
  };
  // Final belt-and-braces pass over the whole serialized report.
  return JSON.parse(redact(JSON.stringify(report)));
}

const ICON = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO', skip: 'SKIP' };
const COLOR = { pass: 32, fail: 31, warn: 33, info: 36, skip: 90 };

export function badgeText(summary) {
  const feats = summary.features.length ? ' · ' + summary.features.join('+') : '';
  return `${summary.score}${feats}`;
}

export function renderTable(report, { color = false } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines = [];
  lines.push(`llm-gateway-doctor ${report.version} · profile ${report.target.profile} · model ${report.target.model}`);
  lines.push(`target ${report.target.base_url}`);
  lines.push('');
  const w = Math.max(...report.checks.map((x) => x.id.length), 10);
  for (const ch of report.checks) {
    lines.push(` ${c(COLOR[ch.status], ICON[ch.status])}  ${ch.id.padEnd(w)}  ${ch.title}`);
    for (const p of ch.problems) lines.push(`       ${' '.repeat(w)}  - ${p}`);
    if (ch.status === 'info' || ch.status === 'skip') for (const n of ch.notes) lines.push(`       ${' '.repeat(w)}  ${c(90, n)}`);
    if (ch.fix_hint) lines.push(`       ${' '.repeat(w)}  ${c(90, 'fix: ' + ch.fix_hint)}`);
  }
  const s = report.summary;
  lines.push('');
  lines.push(`compat ${badgeText(s)}   (${s.pass} pass, ${s.fail} fail, ${s.warn} warn, ${s.info} info, ${s.skip} skip)`);
  return lines.join('\n');
}

export function renderJson(report) {
  return JSON.stringify(report, null, 2);
}

export function renderHtml(report) {
  const s = report.summary;
  const rows = report.checks.map((ch) => {
    const detail = [];
    if (ch.problems.length) detail.push(`<ul class="problems">${ch.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`);
    if (ch.notes.length) detail.push(`<p class="notes">${ch.notes.map(escapeHtml).join(' · ')}</p>`);
    if (ch.fix_hint) detail.push(`<p class="fix"><strong>Fix hint:</strong> ${escapeHtml(ch.fix_hint)}</p>`);
    for (const ex of ch.exchanges || []) {
      const req = ex.request || {};
      const reqText = `${req.method} ${req.url}\n${Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}${req.body ? '\n\n' + req.body : ''}`;
      const resText = ex.error ? ex.error : ex.response ? `HTTP ${ex.response.status}  ${ex.response.content_type || ''}\n\n${ex.response.body}` : '';
      detail.push(`<details><summary>${escapeHtml(ex.label || 'request')} (redacted)</summary><div class="ex"><div><h4>Request</h4><pre>${escapeHtml(reqText)}</pre></div><div><h4>Response</h4><pre>${escapeHtml(resText)}</pre></div></div></details>`);
    }
    return `<tr class="${ch.status}"><td><span class="st ${ch.status}">${ICON[ch.status]}</span></td><td><code>${escapeHtml(ch.id)}</code><div class="t">${escapeHtml(ch.title)}</div>${detail.join('')}</td><td class="sev">${escapeHtml(ch.severity)}</td></tr>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway doctor report</title>
<style>
:root{--bg:#ffffff;--fg:#1b1f24;--muted:#5b6470;--line:#d8dee4;--card:#f6f8fa;--pass:#1a7f37;--fail:#cf222e;--warn:#9a6700;--info:#0969da;--skip:#6e7781}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--card:#161b22;--pass:#3fb950;--fail:#f85149;--warn:#d29922;--info:#58a6ff;--skip:#8b949e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--muted);margin:0 0 16px;word-break:break-all}
.cards{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;min-width:90px}
.card b{display:block;font-size:20px}.score{font-size:18px;margin:8px 0 16px}
table{width:100%;border-collapse:collapse}td{border-top:1px solid var(--line);padding:10px 8px;vertical-align:top}
.st{display:inline-block;font:600 12px/1 ui-monospace,monospace;padding:4px 6px;border-radius:4px;color:#fff}
.st.pass{background:var(--pass)}.st.fail{background:var(--fail)}.st.warn{background:var(--warn)}.st.info{background:var(--info)}.st.skip{background:var(--skip)}
.t{color:var(--muted)}.sev{color:var(--muted);font-size:13px}.problems{margin:6px 0;padding-left:18px;color:var(--fail)}tr.warn .problems{color:var(--warn)}
.notes{margin:4px 0;color:var(--muted);font-size:13px}.fix{margin:6px 0;background:var(--card);border-left:3px solid var(--info);padding:6px 10px}
details{margin:6px 0}summary{cursor:pointer;color:var(--info)}.ex{display:grid;grid-template-columns:1fr 1fr;gap:8px}@media (max-width:700px){.ex{grid-template-columns:1fr}}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;max-height:320px;font-size:12px;white-space:pre-wrap;word-break:break-all}
h4{margin:6px 0}footer{color:var(--muted);font-size:13px;margin-top:24px}
</style>
</head>
<body>
<main>
<h1>llm-gateway-doctor report</h1>
<p class="meta">Profile <strong>${escapeHtml(report.target.profile)}</strong> · model <code>${escapeHtml(report.target.model)}</code> · ${escapeHtml(report.target.base_url)} · ${escapeHtml(report.generated_at)}</p>
<p class="score">compat <strong>${escapeHtml(badgeText(s))}</strong></p>
<div class="cards"><div class="card"><b>${s.pass}</b>pass</div><div class="card"><b>${s.fail}</b>fail</div><div class="card"><b>${s.warn}</b>warn</div><div class="card"><b>${s.info}</b>info</div><div class="card"><b>${s.skip}</b>skip</div><div class="card"><b>${report.plan.requests}</b>requests</div></div>
<table><tbody>
${rows.join('\n')}
</tbody></table>
<footer>Generated by llm-gateway-doctor ${escapeHtml(report.version)} (MIT). Keys and auth headers are redacted. Results describe one run against one model at one point in time; they are not a certification.</footer>
</main>
</body>
</html>
`;
}

function textWidth(s) {
  // Approximate Verdana 11px widths, good enough for a flat badge.
  let w = 0;
  for (const ch of s) w += /[ilj.,:·|!' ]/.test(ch) ? 3.6 : /[mwMW]/.test(ch) ? 10 : /[A-Z0-9+/]/.test(ch) ? 7.5 : 6.6;
  return Math.ceil(w);
}

export function renderBadge(summary) {
  const left = 'compat';
  const right = badgeText(summary);
  const color = summary.fail ? '#e05d44' : summary.warn ? '#dfb317' : '#44cc11';
  const lw = textWidth(left) + 12;
  const rw = textWidth(right) + 12;
  const W = lw + rw;
  const label = `${left}: ${right}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="20" role="img" aria-label="${escapeHtml(label)}">
<title>${escapeHtml(label)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${W}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${W}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeHtml(left)}</text><text x="${lw / 2}" y="14">${escapeHtml(left)}</text>
<text x="${lw + rw / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeHtml(right)}</text><text x="${lw + rw / 2}" y="14">${escapeHtml(right)}</text>
</g>
</svg>
`;
}
