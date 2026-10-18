// GUI acceptance for dsh-tmux-xc 0.1.1 (spec v2). Phases:
//   tree | alias | copy | approval | font | delete | hostremove | nav | nav-stale | visibility
// env: XC_WEB_LOG (dsh web stdout with the token URL), XC_SHOTS (screenshot dir).
// Usage: node scripts/e2e/v011.mjs <phase>
//
// The manager prepares the xc-e2e tmux server before each phase and verifies remote
// effects out-of-band. This script only drives the GUI (plus read-only GETs) and
// prints one JSON object; destructive actions always go through the dialogs.
import { open, webUrl, api } from './lib.mjs';
import { newChat, typeAndSend, runTurn, lastAssistantText } from './chat.mjs';

const phase = process.argv[2];
const S = (process.env.XC_SHOTS ?? '.') + '/';
const HOST_LAB = 'NaMILab (ssh loopback)';
const HOST_DOWN = 'Unreachable host';

const { browser, page, errors } = await open(webUrl(process.env.XC_WEB_LOG));
const out = { phase };
const shot = (name) => page.screenshot({ path: S + name });

// ---------------------------------------------------------------------------
// Panel helpers. The panel lives in the right sidebar; `.xc-root:visible` picks
// the currently mounted instance (keepMounted can leave older ones in the DOM).
// ---------------------------------------------------------------------------

const panel = () => page.locator('.xc-root:visible').last();

async function openPanel() {
  // Click the composer opener whenever it is available: it binds the tab to the
  // CURRENT chat session, so a panel kept mounted from a previous session is not
  // mistaken for this one. Falls back to the sidebar tab.
  const opener = page.locator('.xc-opener:visible').first();
  if (await opener.count()) {
    await opener.click({ timeout: 5000 }).catch(() => {});
  } else if (!(await page.locator('.xc-root:visible').count())) {
    const tab = page.getByText('tmux', { exact: true }).first();
    if (await tab.count()) await tab.click({ timeout: 5000 }).catch(() => {});
  }
  if (!(await page.locator('.xc-root:visible').count())) {
    await newChat(page).catch(() => {});
    const again = page.locator('.xc-opener:visible').first();
    if (await again.count()) await again.click({ timeout: 5000 }).catch(() => {});
  }
  for (let i = 0; i < 30 && !(await page.locator('.xc-root:visible').count()); i++) {
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(2500); // inventory + settings
  return (await page.locator('.xc-root:visible').count()) > 0;
}

async function panelState() {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
    const p = roots[roots.length - 1];
    if (!p) return null;
    const labelOf = (n) => n.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() ?? '';
    const metasOf = (n) => [...n.querySelectorAll(':scope > .xc-metaRow .xc-meta')].map((e) => e.textContent.trim());
    return {
      hosts: [...p.querySelectorAll('.xc-node[data-kind="host"]')].map((n, i) => ({
        i,
        title: labelOf(n),
        unreachable: !!n.querySelector('.xc-badge[data-kind="unreachable"]'),
        error: n.querySelector(':scope > .xc-err')?.textContent.trim() ?? null,
      })),
      sessions: [...p.querySelectorAll('.xc-node[data-kind="session"]')].map((n, i) => ({
        i,
        host: n.closest('.xc-node[data-kind="host"]')?.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() ?? null,
        title: labelOf(n),
        meta: metasOf(n),
        ownBadges: [...n.querySelectorAll(':scope > .xc-nodeRow .xc-badge')].map((e) => e.textContent.trim()),
        badges: [...n.querySelectorAll('.xc-badge')].map((e) => e.textContent.trim()),
        selected: n.classList.contains('xc-selected'),
        highlighted: n.classList.contains('xc-highlight'),
        childSelected: !!n.querySelector('.xc-selected'),
        childHighlighted: !!n.querySelector('.xc-highlight'),
        ids: n.querySelector(':scope > .xc-nodeRow .xc-ids')?.textContent.trim() ?? null,
        actions: [...n.querySelectorAll(':scope > .xc-actions button')].map((b) => b.textContent.trim()),
      })),
      selectedNodes: [...p.querySelectorAll('.xc-node.xc-selected')].map((n) => {
        const session = n.closest('.xc-node[data-kind="session"]');
        return {
          kind: n.dataset.kind,
          title: n.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() ?? '',
          meta: [...n.querySelectorAll(':scope > .xc-metaRow .xc-meta')].map((e) => e.textContent.trim()),
          sessionTitle: session?.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() ?? null,
          sessionMeta: session
            ? [...session.querySelectorAll(':scope > .xc-metaRow .xc-meta')].map((e) => e.textContent.trim())
            : [],
          highlighted: n.classList.contains('xc-highlight'),
        };
      }),
      filterButtons: ['当前工作区', '全部', '已登记'].map((label) => ({
        label,
        count: [...p.querySelectorAll('button')].filter((b) => b.textContent.trim() === label).length,
      })),
    };
  });
}

async function hostRows(hostLabel) {
  return page.evaluate((label) => {
    const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
    const p = roots[roots.length - 1];
    if (!p) return null;
    const host = [...p.querySelectorAll('.xc-node[data-kind="host"]')]
      .find((n) => n.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() === label);
    if (!host) return null;
    const rows = [...host.querySelectorAll('.xc-node')].map((n) => ({
      kind: n.dataset.kind,
      title: n.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() ?? '',
      ids: n.querySelector(':scope > .xc-nodeRow .xc-ids')?.textContent.trim() ?? null,
      meta: [...n.querySelectorAll(':scope > .xc-metaRow .xc-meta')].map((e) => e.textContent.trim()),
      badges: [...n.querySelectorAll(':scope > .xc-nodeRow .xc-badge')].map((e) => e.textContent.trim()),
    }));
    const text = host.innerText;
    return {
      rows,
      rowTitles: rows.map((r) => r.title),
      idTexts: rows.map((r) => r.ids).filter(Boolean),
      idMatches: [...new Set(text.match(/\$\d+|@\d+|%\d+/g) ?? [])],
      genMatches: [...new Set(text.match(/\b\d{4,}-\d{4,}\b/g) ?? [])],
      socketLabels: [...host.querySelectorAll('.xc-socketLabel')].map((e) => e.textContent.trim()),
    };
  }, hostLabel);
}

async function expandAll() {
  // Each pass expands one collapsed caret; the count shrinks as rows open.
  for (let i = 0; i < 200; i++) {
    const carets = panel().locator('button.xc-caret', { hasText: '▸' });
    if (!(await carets.count())) break;
    await carets.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
}

async function toggleAdvanced(on) {
  const b = panel().locator('.xc-header button').filter({ hasText: '高级详情' }).first();
  if (!(await b.count())) return null;
  const pressed = (await b.getAttribute('aria-pressed')) === 'true';
  if (pressed !== on) await b.click();
  await page.waitForTimeout(1500);
  return (await b.getAttribute('aria-pressed')) === 'true';
}

async function hostIndex(label) {
  const st = await panelState();
  return st ? st.hosts.findIndex((h) => h.title === label) : -1;
}

// Index of a session row within one host (the same tmux session can be listed
// under both `lab` and `local`, so never search the whole tree by name).
async function sessionIndex(name, hostLabel = HOST_LAB) {
  return page.evaluate(([label, wanted]) => {
    const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
    const p = roots[roots.length - 1];
    if (!p) return -1;
    const host = [...p.querySelectorAll('.xc-node[data-kind="host"]')]
      .find((n) => n.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() === label);
    if (!host) return -1;
    const sessions = [...host.querySelectorAll('.xc-node[data-kind="session"]')];
    return sessions.findIndex((n) => {
      const title = n.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() ?? '';
      const meta = [...n.querySelectorAll(':scope > .xc-metaRow .xc-meta')].map((e) => e.textContent.trim());
      return title === wanted || title.includes(wanted) || meta.includes(wanted) || meta.some((m) => m.includes(wanted));
    });
  }, [hostLabel, name]);
}

async function sessionRow(name, hostLabel = HOST_LAB) {
  const hi = await hostIndex(hostLabel);
  const si = await sessionIndex(name, hostLabel);
  if (hi < 0 || si < 0) return { hi, si, row: null };
  const host = panel().locator('.xc-node[data-kind="host"]').nth(hi);
  return { hi, si, row: host.locator('.xc-node[data-kind="session"]').nth(si) };
}

async function openHostMenu(hostLabel) {
  const i = await hostIndex(hostLabel);
  if (i < 0) return false;
  const host = panel().locator('.xc-node[data-kind="host"]').nth(i);
  await host.locator(':scope > .xc-nodeRow .xc-menuTrigger').click();
  const pop = page.locator('.xc-menuPop:visible').last();
  await pop.getByRole('menuitem', { name: /移除主机/ }).click();
  await page.waitForTimeout(1000);
  return true;
}

async function treeFont() {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
    const p = roots[roots.length - 1];
    const tree = p?.querySelector('.xc-tree');
    return tree ? getComputedStyle(tree).fontSize : null;
  });
}

async function previewInfo() {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
    const p = roots[roots.length - 1];
    if (!p) return null;
    const text = p.querySelector('.xc-previewText');
    const err = p.querySelector('.xc-preview .xc-err');
    return {
      preview: !!p.querySelector('.xc-preview'),
      header: p.querySelector('.xc-previewHead')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
      text: text ? text.innerText : null,
      error: err ? err.innerText : null,
    };
  });
}

async function waitPreview(timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ready = await page.evaluate(() => {
      const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
      const p = roots[roots.length - 1];
      return !!(p && (p.querySelector('.xc-previewText') || p.querySelector('.xc-preview .xc-err')));
    });
    if (ready) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Approval-panel helpers.
// ---------------------------------------------------------------------------

async function approvalInfo() {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
    const p = roots[roots.length - 1];
    if (!p) return null;
    const sw = p.querySelector('.xc-settings .xc-switch');
    return {
      settingsOpen: !!p.querySelector('.xc-settings'),
      checked: sw ? sw.getAttribute('aria-checked') === 'true' : null,
      value: p.querySelector('.xc-settingValue')?.textContent.trim() ?? null,
      source: p.querySelector('.xc-settingSource')?.textContent.trim() ?? null,
      desc: p.querySelector('.xc-settingDesc')?.textContent.trim() ?? null,
      header: [...p.querySelectorAll('.xc-header button')]
        .find((b) => /插件审批/.test(b.textContent))?.textContent.trim() ?? null,
    };
  });
}

async function openApproval() {
  await openPanel();
  const root = panel();
  if (!(await root.locator('.xc-settings').count())) {
    const b = root.locator('.xc-header button').filter({ hasText: '插件审批' }).first();
    await b.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await root.locator('.xc-settingRow').waitFor({ timeout: 15000 }).catch(() => {});
  return approvalInfo();
}

async function setApproval(on) {
  await openApproval();
  const sw = panel().locator('.xc-settings .xc-switch').first();
  for (let i = 0; i < 20; i++) {
    const checked = (await sw.getAttribute('aria-checked')) === 'true';
    if (checked === on) break;
    await sw.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1500);
  return approvalInfo();
}

const approvalText = async () => page.evaluate(() => [...document.querySelectorAll('*')]
  .filter((e) => /等待审批/.test(e.textContent ?? '') && e.textContent.length < 2000)
  .map((e) => e.textContent)
  .sort((a, b) => a.length - b.length)[0] ?? '');

// ---------------------------------------------------------------------------
// Clipboard: grant permissions (lib.open does not), but also observe the strings
// the panel writes. copyText() falls back to a hidden textarea + execCommand when
// navigator.clipboard.writeText throws, so patch both paths.
// ---------------------------------------------------------------------------

async function installClipboardHooks() {
  await page.addInitScript(() => {
    window.__xcCopied = [];
    const push = (text) => { try { window.__xcCopied.push(String(text)); } catch { /* ignore */ } };
    try {
      const c = navigator.clipboard;
      if (c && typeof c.writeText === 'function' && !c.__xcPatched) {
        const orig = c.writeText.bind(c);
        c.writeText = async (text) => {
          push(text);
          try { return await orig(text); } catch { return undefined; }
        };
        c.__xcPatched = true;
      }
    } catch { /* clipboard API may be absent */ }
    try {
      const origExec = document.execCommand?.bind(document);
      if (origExec) {
        document.execCommand = (cmd, ...rest) => {
          if (String(cmd).toLowerCase() === 'copy') {
            const el = document.activeElement;
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) push(el.value);
          }
          return origExec(cmd, ...rest);
        };
      }
    } catch { /* ignore */ }
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
}

async function patchClipboard() {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const patched = await page.evaluate(() => {
    window.__xcCopied = window.__xcCopied || [];
    const c = navigator.clipboard;
    if (!c || typeof c.writeText !== 'function') return false;
    if (c.__xcPatched) return true;
    const orig = c.writeText.bind(c);
    try {
      c.writeText = async (text) => {
        window.__xcCopied.push(String(text));
        try { return await orig(text); } catch { return undefined; }
      };
      c.__xcPatched = true;
      return true;
    } catch { return false; }
  });
  // The page may have loaded before addInitScript took effect on a reload; if the
  // in-page patch failed, fall back to a context-level permission + readText.
  return patched;
}

async function readClipboard() {
  const captured = await page.evaluate(() => window.__xcCopied || []);
  let read = null;
  try { read = await page.evaluate(() => navigator.clipboard.readText()); } catch { /* denied */ }
  return { captured: captured.length ? captured[captured.length - 1] : null, read };
}

// ---------------------------------------------------------------------------
// Phase bodies.
// ---------------------------------------------------------------------------

async function composerChip() {
  return page.evaluate(() => {
    const comp = document.querySelector('[contenteditable="true"]');
    const inComposer = comp ? [...comp.querySelectorAll('.xc-refchip')] : [];
    const all = [...document.querySelectorAll('.xc-refchip')];
    return {
      inComposer: inComposer.length,
      dataChips: document.querySelectorAll('[data-composer-chip="tmux-xc"]').length,
      total: all.length,
      label: inComposer[0]?.innerText.trim() ?? all[0]?.innerText.trim() ?? null,
    };
  });
}

async function markHistoryChip() {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('.xc-refchip')].filter((e) => !e.closest('[contenteditable="true"]'));
    const inMessage = all.filter((e) => e.closest('[data-message-id]'));
    const pool = inMessage.length ? inMessage : all;
    if (!pool.length) return null;
    const el = pool[pool.length - 1];
    el.setAttribute('data-xc-nav', '1');
    return { label: el.innerText.trim(), title: el.getAttribute('title') };
  });
}

// ---------------------------------------------------------------------------
// Phase bodies.
// ---------------------------------------------------------------------------

try {
  await page.getByRole('button', { name: '继续' }).click({ timeout: 2500 }).catch(() => {});
  await installClipboardHooks().catch(() => {});

  if (phase === 'tree') {
    await newChat(page);
    await openPanel();
    await expandAll();

    out.tree = { host: HOST_LAB, simple: await hostRows(HOST_LAB) };
    out.tree.filterButtons = (await panelState())?.filterButtons ?? null;
    await shot('tree-simple.png');

    await toggleAdvanced(true);
    await expandAll();
    out.tree.advanced = await hostRows(HOST_LAB);
    await shot('tree-adv.png');

    await toggleAdvanced(false);
    await expandAll();
    out.tree.simpleAgain = await hostRows(HOST_LAB);
    out.tree.noFilterButtons = Object.fromEntries((out.tree.filterButtons ?? [])
      .map((f) => [f.label, f.count === 0]));
  } else if (phase === 'alias') {
    await newChat(page);
    await openPanel();
    await expandAll();
    const { row } = await sessionRow('ac-demo');
    if (!row) throw new Error('ac-demo row not found under ' + HOST_LAB);
    await row.locator(':scope > .xc-actions .xc-menuTrigger').last().click();
    const pop = page.locator('.xc-menuPop:visible').last();
    await pop.getByRole('menuitem', { name: '别名' }).click();
    const input = row.locator('.xc-aliasInput');
    await input.fill('AC');
    await input.press('Enter');
    await page.waitForTimeout(5000);

    const st = await panelState();
    const node = st?.sessions.find((s) => s.host === HOST_LAB
      && (s.meta.includes('ac-demo') || s.title === 'AC')) ?? null;
    out.alias = {
      row: node && {
        host: node.host,
        title: node.title,
        meta: node.meta,
        remoteNameShownAsSecondary: node.meta.includes('ac-demo'),
        selected: node.selected,
      },
    };
    await shot('alias.png');

    const res = await api(page, '/api/tmux-xc/inventory?all=1');
    let found = null;
    try {
      const inv = JSON.parse(res.body);
      for (const h of inv.hosts ?? []) {
        for (const so of h.sockets ?? []) {
          for (const se of so.sessions ?? []) {
            if (se.name === 'ac-demo') found = { host: h.id, socket: so.id, session: se };
          }
        }
      }
    } catch { /* recorded as null */ }
    out.alias.inventory = {
      status: res.status,
      node: found && {
        host: found.host,
        socket: found.socket,
        name: found.session.name,
        alias: found.session.alias ?? null,
        adopted: !!found.session.adopted,
        origin: found.session.origin ?? null,
      },
    };
  } else if (phase === 'copy') {
    await newChat(page);
    await openPanel();
    await expandAll();
    const { row } = await sessionRow('ac-demo');
    if (!row) throw new Error('ac-demo row not found under ' + HOST_LAB);
    await patchClipboard();

    await row.getByRole('button', { name: '复制连接命令' }).click();
    let pop = page.locator('.xc-menuPop:visible').last();
    out.copy = {
      labels: await pop.getByRole('menuitem').allInnerTexts(),
      titles: await pop.getByRole('menuitem').evaluateAll((els) => els.map((e) => e.getAttribute('title'))),
      tooltip: await pop.locator('.xc-menuHint').innerText().catch(() => null),
    };
    out.copy.mentionsCmdExe = /cmd\.exe/.test(out.copy.tooltip ?? '');
    await pop.getByRole('menuitem').nth(0).click();
    await page.waitForTimeout(1200);
    out.copy.bash = await readClipboard();
    out.copy.noticeAfterBash = await panel().locator('.xc-notice').innerText().catch(() => null);

    await row.getByRole('button', { name: '复制连接命令' }).click();
    pop = page.locator('.xc-menuPop:visible').last();
    await pop.getByRole('menuitem').nth(1).click();
    await page.waitForTimeout(1200);
    out.copy.powerShell = await readClipboard();
    out.copy.noticeAfterPowerShell = await panel().locator('.xc-notice').innerText().catch(() => null);
  } else if (phase === 'approval') {
    await newChat(page);
    await openPanel();
    const initial = await openApproval();
    out.approval = { initial };
    if (!initial?.checked) await setApproval(true);
    await shot('approval-on.png');

    const onApprovals = [];
    await typeAndSend(page, 'Use tmux_xc_create to create a tmux session named appr-on on host "lab", socket "e2e".');
    const onTurn = await runTurn(page, {
      approve: /^允许一次$/,
      timeoutMs: 300000,
      shot: S + 'approval-on-card.png',
      onApproval: async () => { onApprovals.push(await approvalText(page)); },
    });
    out.approval.on = {
      turn: onTurn,
      approvals: onApprovals,
      approvalText: onApprovals[0] ?? null,
      approvalCard: onApprovals.length > 0 || onTurn.approvals > 0,
    };

    const beforeOff = await setApproval(false);
    await page.reload();
    await page.waitForTimeout(6000);
    if (!(await page.locator('.xc-opener:visible').count())) await newChat(page);
    const afterReload = await openApproval();
    await shot('approval-off.png');
    out.approval.off = { beforeOff, afterReload, persistedOff: afterReload?.checked === false };

    await newChat(page);
    await openPanel();
    let offApprovalText = '';
    await page.evaluate(() => {
      window.__xcApprovalSeen = 0;
      window.__xcApprovalObs?.disconnect();
      const check = () => {
        const hit = [...document.querySelectorAll('button')]
          .some((b) => /^允许一次$/.test((b.innerText || '').trim()));
        if (hit) window.__xcApprovalSeen = 1;
      };
      check();
      window.__xcApprovalObs = new MutationObserver(check);
      window.__xcApprovalObs.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await typeAndSend(page, 'Use tmux_xc_create to create a tmux session named appr-off on host "lab", socket "e2e".');
    // If a card does appear (unexpected), record it and approve so the turn can
    // finish instead of hanging; the observation itself is what matters.
    const offTurn = await runTurn(page, {
      approve: /^允许一次$/,
      timeoutMs: 300000,
      onApproval: async () => {
        await page.evaluate(() => { window.__xcApprovalSeen = 1; }).catch(() => {});
        offApprovalText = await approvalText(page);
      },
    });
    const seen = await page.evaluate(() => {
      window.__xcApprovalObs?.disconnect();
      return window.__xcApprovalSeen || 0;
    });
    out.approval.off.turn = offTurn;
    out.approval.off.approvalCard = seen > 0 || offTurn.approvals > 0;
    out.approval.off.approvalText = offApprovalText || null;
    out.approval.off.reply = await lastAssistantText(page);

    out.approval.restored = await setApproval(true);
  } else if (phase === 'font') {
    await openPanel();
    const base = await treeFont();
    const plus = panel().getByRole('button', { name: '增大字号' });
    for (let i = 0; i < 3; i++) {
      await plus.click();
      await page.waitForTimeout(400);
    }
    const grown = await treeFont();
    await shot('font-grown.png');

    await page.reload();
    await page.waitForTimeout(6000);
    if (!(await page.locator('.xc-opener:visible').count())) await newChat(page);
    await openPanel();
    const afterReload = await treeFont();

    const minus = panel().getByRole('button', { name: '减小字号' });
    for (let i = 0; i < 3; i++) {
      await minus.click();
      await page.waitForTimeout(400);
    }
    const back = await treeFont();
    out.font = { base, grown, afterReload, back, persisted: afterReload === grown };
  } else if (phase === 'delete') {
    await newChat(page);
    await openPanel();
    await expandAll();
    const { si, row } = await sessionRow('del-me');
    out.delete = { foundRow: !!row, sessionIndex: si };
    if (!row) throw new Error('del-me row not found under ' + HOST_LAB);
    await row.getByRole('button', { name: '删除会话' }).click();

    const dialog = page.locator('.xc-modal[role="dialog"]').last();
    await dialog.waitFor({ timeout: 15000 });
    const dialogText = await dialog.innerText();
    await shot('delete-dialog.png');

    out.delete.dialogText = dialogText;
    // 0.1.1: click-confirmed deletion (no typed internal ids); the red button sends the computed confirm.
    const confirm = dialog.locator('.xc-dialogActions button.xc-danger').first();
    await confirm.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    out.delete.confirmDisabled = await confirm.isDisabled();
    if (!out.delete.confirmDisabled) await confirm.click();
    await dialog.waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);

    out.delete.gone = (await sessionIndex('del-me')) < 0;
    out.delete.rowTitlesAfter = (await panelState())?.sessions
      .filter((s) => s.host === HOST_LAB).map((s) => s.title) ?? null;
    out.delete.notice = await panel().locator('.xc-notice').innerText().catch(() => null);
  } else if (phase === 'hostremove') {
    await newChat(page);
    await openPanel();
    // Advanced mode lists every host/socket explicitly, so `down` and `lab` are
    // both present even when a host has no sessions.
    await toggleAdvanced(true);
    await expandAll();
    out.hostremove = { advanced: true };

    // --- Unreachable host: only plugin-only removal is offered. ---
    if (await openHostMenu(HOST_DOWN)) {
      const dialog = page.locator('.xc-modal[role="dialog"]').last();
      await dialog.waitFor({ timeout: 15000 });
      await dialog.locator('.xc-choice').first().waitFor({ timeout: 90000 }).catch(() => {});
      const choices = await dialog.locator('.xc-choice').evaluateAll((els) => els.map((e) => ({
        text: (e.innerText || '').replace(/\s+/g, ' ').trim(),
        className: e.className,
        tag: e.tagName,
        renderedDisabled: e.tagName === 'BUTTON' ? e.disabled : true,
      })));
      const local = choices.find((c) => /仅从插件移除/.test(c.text));
      const remote = choices.find((c) => /先终止所选远端会话/.test(c.text));
      out.hostremove.down = {
        choices,
        localEnabled: !!local && local.tag === 'BUTTON' && !local.renderedDisabled,
        remoteEnabled: !!remote && remote.tag === 'BUTTON' && !remote.renderedDisabled,
        explanation: await dialog.locator('.xc-choiceDisabled .xc-choiceDesc').innerText().catch(() => null),
        scope: await dialog.locator('.xc-scope').innerText().catch(() => null),
      };
      await shot('hostremove-down.png');
      await dialog.getByRole('button', { name: '取消' }).click();
      await dialog.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    } else {
      out.hostremove.down = { missing: true };
    }

    // --- Reachable lab host: choose only rm-sel, remote mode. ---
    if (await openHostMenu(HOST_LAB)) {
      const dialog = page.locator('.xc-modal[role="dialog"]').last();
      await dialog.waitFor({ timeout: 15000 });
      await dialog.locator('.xc-choice').first().waitFor({ timeout: 90000 }).catch(() => {});
      await dialog.locator('.xc-dialogRow').first().waitFor({ timeout: 20000 }).catch(() => {});

      const checklist = await dialog.locator('.xc-dialogRow').evaluateAll((rows) => rows.map((r) => ({
        label: r.querySelector('.xc-dialogRowLabel')?.textContent.trim() ?? '',
        checked: !!r.querySelector('input[type="checkbox"]')?.checked,
        badge: r.querySelector('.xc-badge')?.textContent.trim() ?? null,
      })));
      await shot('hostremove-sessions.png');

      const rows = dialog.locator('.xc-dialogRow');
      for (let k = 0; k < await rows.count(); k++) {
        const r = rows.nth(k);
        const want = (await r.innerText()).includes('rm-sel');
        const cb = r.locator('input[type="checkbox"]');
        if ((await cb.isChecked()) !== want) await cb.click();
      }
      const selectedAfter = await dialog.locator('.xc-dialogRow').evaluateAll((rs) => rs.map((r) => ({
        label: r.querySelector('.xc-dialogRowLabel')?.textContent.trim() ?? '',
        checked: !!r.querySelector('input[type="checkbox"]')?.checked,
      })));

      // Click the choice title (clicking the box centre would toggle a checkbox), then re-assert selection.
      const remoteChoice = dialog.locator('.xc-choice').filter({ hasText: '先终止所选远端会话' }).locator('.xc-choiceTitle').first();
      if (await remoteChoice.count()) await remoteChoice.click();
      for (let k = 0; k < await rows.count(); k++) {
        const r = rows.nth(k);
        const want = (await r.innerText()).includes('rm-sel');
        const cb = r.locator('input[type="checkbox"]');
        if ((await cb.isChecked()) !== want) await cb.click();
      }
      const hint = await dialog.locator('.xc-confirmHint').innerText();
      const hostId = (hint.match(/[：:]\s*(\S+)\s*$/) ?? [])[1] ?? 'lab';
      await dialog.locator('.xc-confirmInput').fill(hostId);

      const confirm = dialog.locator('.xc-dialogActions button.xc-danger').first();
      const summary = { checklist, selectedAfter, hostId };
      summary.confirmDisabled = await confirm.isDisabled();
      const respP = page.waitForResponse(
        (r) => r.url().includes('/api/tmux-xc/host/remove') && r.request().method() === 'POST',
        { timeout: 180000 },
      ).catch(() => null);
      if (!summary.confirmDisabled) await confirm.click();
      const resp = await respP;
      let body = null;
      try { body = resp ? await resp.json() : null; } catch { /* non-JSON */ }

      await page.waitForTimeout(6000);
      const stillOpen = (await dialog.count()) > 0;
      const remoteRows = Array.isArray(body?.remote) ? body.remote : [];
      out.hostremove.lab = {
        ...summary,
        response: { status: resp ? resp.status() : null, body },
        dialogGone: !stillOpen,
        resultsText: stillOpen
          ? await dialog.locator('.xc-results').innerText().catch(() => null)
          : remoteRows.map((r) => `${r.label}: ${r.ok ? '已终止' : '失败'}`).join('\n'),
        warning: stillOpen
          ? await dialog.locator('.xc-dialogWarn').innerText().catch(() => null)
          : null,
      };
      await shot('hostremove-results.png');

      await page.waitForTimeout(2000);
      out.hostremove.lab.hostRemoved = (await hostIndex(HOST_LAB)) < 0;

      // --- Advanced details -> removed hosts -> 恢复. ---
      if ((await toggleAdvanced(true)) !== true) await page.waitForTimeout(500);
      out.hostremove.lab.removedSection = await panel().locator('.xc-removedHosts')
        .innerText().catch(() => null);
      const restoreRow = panel().locator('.xc-removedHosts .xc-removedHostRow')
        .filter({ hasText: 'lab' }).first();
      if (await restoreRow.count()) await restoreRow.getByRole('button', { name: '恢复' }).click();
      await page.waitForTimeout(6000);
      out.hostremove.lab.restored = (await hostIndex(HOST_LAB)) >= 0;
      out.hostremove.lab.removedSectionAfter = await panel().locator('.xc-removedHosts')
        .innerText().catch(() => null);
      await shot('hostremove-restored.png');
    } else {
      out.hostremove.lab = { missing: true };
    }
  } else if (phase === 'nav' || phase === 'nav-stale') {
    const stale = phase === 'nav-stale';
    const target = stale ? 'navStale' : 'nav';
    out[target] = {};

    let chip = null;
    if (stale) {
      // Reopen the conversation from the nav phase (titled from its 'reply OK' prompt).
      await page.locator('[role=treeitem]').filter({ hasText: /Reply OK/i }).first().click();
      await page.waitForTimeout(4000);
    }
    if (!stale) {
      await newChat(page);
      await openPanel();
      await expandAll();
      const { row } = await sessionRow('ac-demo');
      if (!row) throw new Error('ac-demo row not found under ' + HOST_LAB);
      await row.getByRole('button', { name: '引用窗格' }).click();
      await page.waitForTimeout(1500);

      out.nav.composerChip = await composerChip();
      await typeAndSend(page, 'Just reply OK, do not use tools.');
      out.nav.turn = await runTurn(page, { timeoutMs: 180000 });
      out.nav.reply = await lastAssistantText(page);

      // Close the right sidebar if a close control is exposed; best effort only.
      const close = page.locator('aside button[aria-label*="关闭"], [class*="sidebar"] button[aria-label*="关闭"], button[aria-label*="收起"]');
      if (await close.count()) {
        await close.last().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1200);
        out.nav.sidebarClosed = !(await page.locator('.xc-root:visible').count());
      } else {
        out.nav.sidebarClosed = false;
      }
      chip = await markHistoryChip();
      if (!chip) {
        // The chip may only render after the stream settles; give it one more try.
        await page.waitForTimeout(3000);
        chip = await markHistoryChip();
      }
    } else {
      // The manager has restarted the tmux server; this is a fresh page load that
      // normally restores the nav chat as the latest session.
      chip = await markHistoryChip();
      if (!chip) {
        const item = page.getByText('Just reply OK, do not use tools.').first();
        if (await item.count()) {
          await item.click().catch(() => {});
          await page.waitForTimeout(3000);
          chip = await markHistoryChip();
        }
      }
      if (!chip) {
        await openPanel();
        chip = await markHistoryChip();
      }
    }

    out[target].chip = chip;
    if (chip) {
      await page.locator('[data-xc-nav="1"]').click();
      await page.waitForTimeout(2000);
      const ready = await waitPreview(45000);
      const st = await panelState();
      const selected = st ? (st.selectedNodes ?? []) : [];
      out[target].panelOpened = (await page.locator('.xc-root:visible').count()) > 0;
      out[target].previewReady = ready;
      out[target].preview = await previewInfo();
      out[target].selectedRows = selected;
      out[target].acDemoSelected = selected.some((s) => s.title === 'AC'
        || s.meta.includes('ac-demo')
        || s.title.includes('ac-demo')
        || (s.sessionTitle ?? '') === 'AC'
        || (s.sessionTitle ?? '').includes('ac-demo')
        || (s.sessionMeta ?? []).includes('ac-demo'));
      out[target].selectedCount = selected.length;
      out[target].highlightedCount = await page.evaluate(() => {
        const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
        return roots[roots.length - 1]?.querySelectorAll('.xc-node.xc-highlight').length ?? 0;
      });
      if (stale) {
        out[target].staleMessage = out[target].preview?.error ?? null;
        out[target].honestStale = /服务已重启|restarted|已失效/.test(out[target].staleMessage ?? '');
        out[target].noOtherRowSelected = selected.every((s) => s.kind === 'host' || s.kind === 'socket');
      } else {
        out[target].previewHasMarker = /NAV-MARKER/.test(out[target].preview?.text ?? '');
      }
      await shot(stale ? 'nav-stale.png' : 'nav.png');
    } else {
      await shot(stale ? 'nav-stale.png' : 'nav.png');
    }
  } else if (phase === 'visibility') {
    await newChat(page);
    await openPanel();
    // Do NOT force-expand sessions: with the default expansion state a session
    // auto-expands as soon as it contains a registered (adopted/created) node,
    // which is exactly the badge this phase waits for.

    const t0 = Date.now();
    let doneAt = 0;
    await typeAndSend(page, 'Use tmux_xc_adopt to register the tmux pane of session vis-demo on host "lab" socket "e2e" (find it with tmux_xc_list), then reply with its reference token.');
    const turnP = runTurn(page, { approve: /^允许一次$/, timeoutMs: 300000 });
    turnP.then(() => { doneAt = Date.now(); }, () => { doneAt = Date.now(); });

    let badge = null;
    const poll = async () => page.evaluate(() => {
      const roots = [...document.querySelectorAll('.xc-root')].filter((e) => e.offsetParent !== null);
      const p = roots[roots.length - 1];
      if (!p) return { panel: false };
      const node = [...p.querySelectorAll('.xc-node[data-kind="session"]')].find((n) => {
        const title = n.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() ?? '';
        const meta = [...n.querySelectorAll(':scope > .xc-metaRow .xc-meta')].map((e) => e.textContent.trim());
        return title === 'vis-demo' || meta.includes('vis-demo');
      });
      if (!node) return { panel: true, found: false };
      const ownBadges = [...node.querySelectorAll(':scope > .xc-nodeRow .xc-badge')].map((e) => e.textContent.trim());
      const childBadges = [...node.querySelectorAll('.xc-children .xc-badge')].map((e) => e.textContent.trim());
      const badges = [...node.querySelectorAll('.xc-badge')].map((e) => e.textContent.trim());
      return {
        panel: true,
        found: true,
        title: node.querySelector(':scope > .xc-nodeRow .xc-label')?.textContent.trim() ?? null,
        expanded: !!node.querySelector(':scope > .xc-children'),
        ownBadges,
        childBadges,
        badges,
        registered: badges.some((b) => b === '已采纳' || b === '已创建'),
      };
    });

    while (Date.now() - t0 < 180000) {
      const st = await poll();
      if (st?.registered) {
        badge = { seconds: Math.round((Date.now() - t0) / 100) / 10, ...st };
        break;
      }
      if (doneAt && Date.now() - doneAt > 30000) break;
      await page.waitForTimeout(1000);
    }
    const turn = await turnP.catch((e) => ({ error: String(e) }));
    if (!badge) {
      const st = await poll();
      badge = st?.registered
        ? { seconds: Math.round((Date.now() - t0) / 100) / 10, ...st }
        : null;
    }
    await shot('visibility.png');
    out.visibility = {
      badge,
      secondsToBadge: badge?.seconds ?? null,
      ownBadges: badge?.ownBadges ?? null,
      childBadges: badge?.childBadges ?? null,
      badges: badge?.badges ?? null,
      turn,
      reply: await lastAssistantText(page),
    };
  } else {
    out.unknownPhase = true;
  }
} catch (error) {
  out.fatal = String(error?.stack || error);
}

out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
