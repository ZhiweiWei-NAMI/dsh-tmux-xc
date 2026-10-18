// GUI acceptance (PRD A1–A4, A12) against an isolated `dsh web` on NaMILab. Phases: A | B | A4 | A12.
// env: XC_WEB_LOG (dsh web stdout with the token URL), XC_SHOTS (dir), XC_PANE (%N to reference in phase B),
//      XC_HOST_LABEL (panel host block to use, default "NaMILab (ssh loopback)").
import { open, webUrl } from './lib.mjs';
import { newChat, typeAndSend, runTurn } from './chat.mjs';
const phase = process.argv[2];
const S = (process.env.XC_SHOTS ?? '.') + '/';
const { browser, page, errors } = await open(webUrl(process.env.XC_WEB_LOG));
await page.getByRole('button', { name: '继续' }).click({ timeout: 3000 }).catch(() => {});
const out = { phase };
async function openPanelExpanded() {
  await page.locator('.xc-opener').first().click(); await page.waitForTimeout(3000);
  await page.getByRole('button', { name: '全部' }).first().click().catch(() => {}); await page.waitForTimeout(3000);
  for (let i = 0; i < 40; i++) { const c = page.locator('button.xc-caret', { hasText: '▸' }); if (!(await c.count())) break; await c.first().click(); await page.waitForTimeout(250); }
}
const approvalText = async () => page.evaluate(() => [...document.querySelectorAll('*')].filter(e => /等待审批/.test(e.textContent) && e.textContent.length < 2000).map(e => e.textContent).sort((a, b) => a.length - b.length)[0] ?? '');
let approvals = [];
const onApproval = async () => { approvals.push(await approvalText()); };
if (phase === 'A') {
  await newChat(page);
  await typeAndSend(page, 'Chat A: use tmux_xc_create to create a new tmux session named demo-a on host "lab", socket "e2e", then report the reference token.');
  out.turn = await runTurn(page, { approve: /^允许一次$/, shot: S + 'A1.png', onApproval });
} else if (phase === 'B') {
  await newChat(page);
  await openPanelExpanded();
  const pane = process.env.XC_PANE;
  const row = page.locator('div, li').filter({ hasText: new RegExp(`^\\s*${pane}\\b`) }).filter({ has: page.getByRole('button', { name: '引用' }) }).first();
  const rows = page.getByRole('button', { name: '引用' });
  // fall back to scanning rows whose text starts with the pane id
  let clicked = false;
  for (const el of await page.locator('[class*="xc-"]').filter({ hasText: pane }).filter({ has: rows }).all()) {
    const t = (await el.innerText()).trim();
    if (t.startsWith(pane) || t.includes(`${pane} `)) { const b = el.getByRole('button', { name: '引用' }); if (await b.count() === 1) { await b.click(); clicked = true; break; } }
  }
  if (!clicked) await row.getByRole('button', { name: '引用' }).first().click();
  await page.waitForTimeout(2000);
  out.composerChip = await page.evaluate(() => document.querySelector('[data-composer-chip="tmux-xc"]')?.innerText?.replace(/\s+/g, ' ').trim());
  out.messagesBeforeSend = await page.evaluate(() => document.querySelectorAll('[class*="user-message"], [data-role="user"]').length);
  await page.screenshot({ path: S + 'A2-chip.png' });
  await typeAndSend(page, 'Send the text "echo hello-from-B" followed by Enter to exactly this referenced tmux pane, then capture its last 5 lines.');
  out.turn = await runTurn(page, { approve: /^允许一次$/, shot: S + 'A3.png', onApproval });
} else if (phase === 'A4') {
  await page.getByText(process.env.XC_CHAT_TITLE ?? 'hello-from-B').first().click(); await page.waitForTimeout(3000);
  await page.reload(); await page.waitForTimeout(6000);
  out.historyChip = await page.evaluate(() => [...document.querySelectorAll('span,button')].filter(e => /demo-a/.test(e.textContent) && e.textContent.length < 120).map(e => e.textContent.trim())[0]);
  await page.screenshot({ path: S + 'A4-reload.png' });
  await typeAndSend(page, '/compact'); await page.waitForTimeout(1200); await page.keyboard.press('Enter').catch(() => {});
  out.compact = await runTurn(page, { timeoutMs: 240000, shot: S + 'A4-compacted.png' });
  await typeAndSend(page, 'Without asking me, send "echo hello-after-compact" followed by Enter to the tmux pane I referenced earlier in this conversation, and confirm.');
  out.turn = await runTurn(page, { approve: /^允许一次$/, shot: S + 'A4-after.png', onApproval });
} else if (phase === 'A12') {
  await page.getByText(process.env.XC_CHAT_TITLE ?? 'hello-from-B').first().click(); await page.waitForTimeout(3000);
  await typeAndSend(page, 'After the DSH restart: resolve the tmux pane referenced in this conversation and capture its last 6 lines. Do not send anything.');
  out.turn = await runTurn(page, { approve: /^允许一次$/, shot: S + 'A12.png', onApproval });
}
out.approvals = approvals; out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
