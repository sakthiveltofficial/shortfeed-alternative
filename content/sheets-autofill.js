// ShortFeed Google Sheets Auto-Fill Content Script
// Automatically populates a newly created Google Sheet when launched from ShortFeed's "Export -> Google Sheets".

(function () {
  if (window.__SHORTFEED_SHEETS_AUTOFILL__) return;
  window.__SHORTFEED_SHEETS_AUTOFILL__ = true;

  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;

  const MAX_AGE_MS = 120000;

  function showStatusToast(text, isDone = false) {
    let toast = document.getElementById('sf-sheets-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'sf-sheets-toast';
      Object.assign(toast.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: '2147483647',
        background: '#17171a',
        color: '#f4f4f6',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '10px',
        padding: '10px 14px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
        fontWeight: '600',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        transition: 'opacity 0.25s ease'
      });
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    if (isDone) {
      toast.style.borderColor = 'rgba(16, 185, 129, 0.45)';
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 3500);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForSheetsEditor(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const grid = document.querySelector('#waffle-grid-container, .grid-scrollable-wrapper, .cell-input');
      const textIframe = document.querySelector('iframe.docs-texteventtarget-iframe');
      if (grid && (textIframe?.contentDocument?.body || document.querySelector('.waffle-paste-target'))) {
        return { grid, textIframe };
      }
      await sleep(250);
    }
    return null;
  }

  function setSpreadsheetTitle(title) {
    try {
      if (!title) return;
      const titleInput = document.querySelector('input.docs-title-input');
      if (!titleInput) return;
      titleInput.focus();
      titleInput.value = title;
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      titleInput.dispatchEvent(new Event('change', { bubbles: true }));
      titleInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        })
      );
      titleInput.blur();
    } catch {}
  }

  function focusCellA1(grid) {
    try {
      const cellTarget =
        document.querySelector('.grid-scrollable-wrapper') ||
        grid;
      if (cellTarget) {
        const rect = cellTarget.getBoundingClientRect();
        const x = rect.left + 80;
        const y = rect.top + 36;
        ['mousedown', 'mouseup', 'click'].forEach((type) => {
          cellTarget.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y
            })
          );
        });
      }
    } catch {}
  }

  function dispatchSyntheticPaste(targetDoc, targetEl, tsv, htmlTable) {
    if (!targetEl) return false;
    try {
      const Win = targetDoc.defaultView || window;
      const dt = new Win.DataTransfer();
      if (tsv) dt.setData('text/plain', tsv);
      if (htmlTable) dt.setData('text/html', htmlTable);

      const pasteEvent = new Win.ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      targetEl.focus?.();
      targetEl.dispatchEvent(pasteEvent);
      return true;
    } catch {
      return false;
    }
  }

  async function runAutofill() {
    const stored = await chrome.storage.local.get(['sf_pending_sheets_export']);
    const pending = stored?.sf_pending_sheets_export;
    if (!pending || !pending.tsv || !pending.createdAt) return;
    if (Date.now() - pending.createdAt > MAX_AGE_MS) {
      await chrome.storage.local.remove('sf_pending_sheets_export');
      return;
    }

    // Clear immediately so future blank sheets are unaffected
    await chrome.storage.local.remove('sf_pending_sheets_export');

    const rowCount = pending.rowCount || Math.max(1, pending.tsv.split('\n').length - 1);
    showStatusToast(`⚡ ShortFeed: Auto-filling ${rowCount} sorted posts...`);

    const editor = await waitForSheetsEditor(16000);
    if (!editor) {
      showStatusToast('ShortFeed: Sheet took too long to load — press Cmd+V / Ctrl+V to paste', true);
      return;
    }

    await sleep(600);

    // 1. Set spreadsheet title
    setSpreadsheetTitle(pending.sheetTitle);
    await sleep(250);

    // 2. Focus cell A1 and Google Sheets text event target
    focusCellA1(editor.grid);
    await sleep(200);

    const textIframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    const iframeDoc = textIframe?.contentDocument || null;
    const pasteTarget =
      document.querySelector('.waffle-paste-target') ||
      iframeDoc?.activeElement ||
      iframeDoc?.body?.querySelector('[contenteditable="true"]') ||
      iframeDoc?.body ||
      document.activeElement ||
      editor.grid;

    if (iframeDoc?.defaultView) {
      iframeDoc.defaultView.focus?.();
    }
    pasteTarget?.focus?.();
    await sleep(100);

    // 3. Dispatch synthetic ClipboardEvent('paste') with both TSV and styled HTML table
    let pasted = false;
    if (iframeDoc && (iframeDoc.activeElement || iframeDoc.body)) {
      pasted = dispatchSyntheticPaste(
        iframeDoc,
        iframeDoc.activeElement || iframeDoc.body,
        pending.tsv,
        pending.htmlTable
      );
      if (!pasted) {
        try {
          pasted = iframeDoc.execCommand('paste');
        } catch {}
      }
    }

    if (!pasted) {
      pasted = dispatchSyntheticPaste(
        document,
        document.querySelector('.waffle-paste-target') || document.activeElement || editor.grid,
        pending.tsv,
        pending.htmlTable
      );
    }

    showStatusToast(`✓ ShortFeed: Populated ${rowCount} sorted rows!`, true);
  }

  runAutofill();
})();
