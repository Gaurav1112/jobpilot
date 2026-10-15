import { html, type Html } from '../html.js';
import { u } from '../paths.js';

export type Nav = 'jobs' | 'freelance' | 'companies' | 'facts' | 'runs';

export interface Banner {
  readonly tone: 'warn' | 'critical' | 'info';
  readonly text: Html | string;
}

export interface LayoutData {
  readonly base: string;
  readonly title: string;
  readonly nav: Nav;
  readonly banners: readonly Banner[];
  readonly body: Html;
}

const navLink = (href: string, label: string, here: boolean): Html =>
  html`<a href="${href}"${here ? html` aria-current="page"` : ''}>${label}</a>`;

/**
 * Every page: no inline script or style (the CSP forbids both), the stylesheet and the vendored htmx from the
 * dashboard itself. htmx only enhances forms that already work as plain POSTs.
 */
export function layout(d: LayoutData): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="same-origin">
<meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false,"allowScriptTags":false,"selfRequestsOnly":true}'>
<title>${d.title} · jobpilot</title>
<link rel="stylesheet" href="${u(d.base, '/static/app.css')}">
<script src="${u(d.base, '/static/htmx.min.js')}" defer></script>
<script src="${u(d.base, '/static/app.js')}" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<div class="top-inner">
<a class="brand" href="${u(d.base, '/')}">jobpilot</a>
<nav aria-label="Main">${navLink(u(d.base, '/'), 'Jobs', d.nav === 'jobs')}${navLink(u(d.base, '/freelance'), 'Freelance', d.nav === 'freelance')}${navLink(u(d.base, '/companies'), 'Companies', d.nav === 'companies')}${navLink(u(d.base, '/facts'), 'Your facts', d.nav === 'facts')}${navLink(u(d.base, '/runs'), 'Runs', d.nav === 'runs')}</nav>
</div>
</header>
<main id="main">
<p id="htmx-error" class="toast" role="alert" aria-live="assertive" hidden></p>
<div id="live" class="visually-hidden" role="status" aria-live="polite"></div>
${d.banners.map((b) => html`<p class="banner banner-${b.tone}" role="${b.tone === 'critical' ? 'alert' : 'status'}">${b.text}</p>`)}
${d.body}
</main>
</body>
</html>
`;
}
