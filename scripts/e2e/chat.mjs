// Chat helpers for the DSH web UI (zh locale).
export async function newChat(page) {
  await page.getByText('新会话').first().click(); await page.waitForTimeout(1500);
}
export async function typeAndSend(page, text) {
  const box = page.locator('[contenteditable="true"]').last();
  await box.click(); await page.keyboard.press('End');
  await page.keyboard.type(text); await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
}
// Wait until the turn is idle; approve each approval card matching `approve` (regex of button names) when it appears.
export async function runTurn(page, { approve = null, timeoutMs = 240000, shot = null, onApproval = null } = {}) {
  const t0 = Date.now(); let approvals = 0; let idleSince = 0;
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(2000);
    if (approve) {
      const btn = page.getByRole('button', { name: approve }).first();
      if (await btn.count() && await btn.isVisible().catch(() => false)) {
        if (onApproval) await onApproval(approvals);
        if (shot) await page.screenshot({ path: shot.replace('.png', `-approval${approvals}.png`) });
        await btn.click(); approvals++; idleSince = 0; continue;
      }
    }
    const busy = await page.locator('button[aria-label*="停止"], button[aria-label*="Stop"], [aria-label*="中止"]').count();
    if (!busy) { idleSince ||= Date.now(); if (Date.now() - idleSince > 6000) break; } else idleSince = 0;
  }
  if (shot) await page.screenshot({ path: shot });
  return { approvals, ms: Date.now() - t0 };
}
export async function lastAssistantText(page) {
  return page.evaluate(() => { const n = [...document.querySelectorAll('[data-message-id]')]; return n.slice(-2).map(e => e.innerText.slice(0, 1500)).join('\n---\n'); });
}
