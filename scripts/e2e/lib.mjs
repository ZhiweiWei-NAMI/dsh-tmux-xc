// E2E helpers (NaMILab only): drive an isolated `dsh web` instance with playwright-core.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.XC_PLAYWRIGHT_FROM ?? '/tmp/aero-road-overlay-codex-20260930/frontend/node_modules/');
const { chromium } = require('playwright-core');
export const CHROME = process.env.XC_CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;
export function webUrl(log) {
  return readFileSync(log, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/g)?.pop();
}
export async function open(url, { viewport = { width: 1500, height: 950 } } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text().slice(0, 300)); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url().replace(/token=[^&]+/, 'token=…')}`); });
  await page.goto(url);
  await page.waitForTimeout(6000);
  return { browser, page, errors };
}
export async function api(page, path, init) {
  return page.evaluate(async ([p, i]) => {
    const r = await fetch(new URL(p, document.baseURI), { credentials: 'same-origin', ...(i ?? {}) });
    return { status: r.status, body: await r.text() };
  }, [path, init]);
}
