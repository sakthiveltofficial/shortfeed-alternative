// ShortFeed Saved Posts Library (app.sortfeed.com equivalent) & Interactive Creator Sandbox

document.addEventListener('DOMContentLoaded', async () => {
  const viewSandbox = document.getElementById('viewSandbox');
  const viewLibrary = document.getElementById('viewLibrary');
  const libraryTopBar = document.getElementById('libraryTopBar');
  const libraryViewTitle = document.getElementById('libraryViewTitle');
  const savedPostsGrid = document.getElementById('savedPostsGrid');
  const navCountAll = document.getElementById('navCountAll');
  const collectionsNavList = document.getElementById('collectionsNavList');
  const searchSavedInput = document.getElementById('searchSavedInput');
  const sortSavedSelect = document.getElementById('sortSavedSelect');
  const btnNewCollection = document.getElementById('btnNewCollection');
  const btnExportSavedCsv = document.getElementById('btnExportSavedCsv');
  const btnSeedSampleSaves = document.getElementById('btnSeedSampleSaves');

  const savedDetailBackdrop = document.getElementById('savedDetailBackdrop');
  const detailModalBody = document.getElementById('detailModalBody');
  const btnCloseDetailModal = document.getElementById('btnCloseDetailModal');

  let savedPosts = [];
  let collections = [];
  let currentView = 'sandbox';
  let activeCollectionId = null;

  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  async function storageGet(keys) {
    if (hasChromeStorage) {
      return await chrome.storage.local.get(keys);
    }
    const out = {};
    keys.forEach((k) => {
      try {
        const raw = localStorage.getItem(k);
        if (raw) out[k] = JSON.parse(raw);
      } catch {}
    });
    return out;
  }

  async function storageSet(obj) {
    if (hasChromeStorage) {
      await chrome.storage.local.set(obj);
      return;
    }
    Object.entries(obj).forEach(([k, v]) => {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    });
  }

  window.addEventListener('SF_LOCAL_SAVE_POST', async (e) => {
    const post = e.detail;
    if (!post || !post.id) return;
    if (!savedPosts.some((p) => p.id === post.id)) {
      savedPosts.unshift({ ...post, savedAt: Date.now(), collections: [], tags: [], notes: '' });
      await storageSet({ sf_saved_posts: savedPosts });
      navCountAll.textContent = String(savedPosts.length);
      renderCollectionsNav();
    }
  });

  window.addEventListener('SF_LOCAL_REMOVE_POST', async (e) => {
    const id = e.detail;
    savedPosts = savedPosts.filter((p) => p.id !== id);
    await storageSet({ sf_saved_posts: savedPosts });
    navCountAll.textContent = String(savedPosts.length);
    renderCollectionsNav();
  });

  await loadLibraryState();

  // Check URL query params
  const params = new URLSearchParams(location.search);
  const requestedTab = params.get('tab');
  const requestedMetric = params.get('metric') || 'outlier';
  const requestedLimit = Number(params.get('limit')) || 25;

  if (requestedTab === 'saved') {
    switchView('all');
  } else {
    switchView('sandbox');
    setTimeout(() => {
      triggerInPageSandboxSort(requestedMetric, requestedLimit);
    }, 150);
  }

  // Sidebar navigation
  document.querySelectorAll('.sf-nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCollectionId = null;
      switchView(btn.dataset.view);
    });
  });

  // Sandbox quick sort buttons
  document.querySelectorAll('[data-run-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const metric = btn.getAttribute('data-run-sort') || 'outlier';
      triggerInPageSandboxSort(metric, 25);
    });
  });

  function triggerInPageSandboxSort(metric, postLimit = 25) {
    const wrapper = document.getElementById('sf-sorted-wrapper');
    if (wrapper) {
      const sortItem = wrapper.querySelector(`[data-sort-metric="${metric}"]`);
      if (sortItem) {
        sortItem.click();
        return;
      }
    }
    window.postMessage({ type: 'SF_SANDBOX_SORT', metric, postLimit }, '*');
  }

  async function loadLibraryState() {
    const data = await storageGet(['sf_saved_posts', 'sf_collections']);
    savedPosts = Array.isArray(data.sf_saved_posts) ? data.sf_saved_posts : [];
    collections = Array.isArray(data.sf_collections)
      ? data.sf_collections
      : [
          { id: 'col_hooks', name: 'Viral Hooks to Try' },
          { id: 'col_outliers', name: '10x+ Breakout Formats' }
        ];
    navCountAll.textContent = String(savedPosts.length);
    renderCollectionsNav();
  }

  function renderCollectionsNav() {
    collectionsNavList.innerHTML = collections
      .map(
        (c) => `
        <button type="button" class="sf-nav-item ${activeCollectionId === c.id ? 'is-active' : ''}" data-col-id="${c.id}">
          <span>📁 ${escapeHtml(c.name)}</span>
          <span class="sf-nav-count">${savedPosts.filter((p) => (p.collections || []).includes(c.id)).length}</span>
        </button>`
      )
      .join('');

    collectionsNavList.querySelectorAll('[data-col-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCollectionId = btn.getAttribute('data-col-id');
        switchView('collection');
      });
    });
  }

  function switchView(viewName) {
    currentView = viewName;
    document.querySelectorAll('.sf-nav-item').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === viewName && !activeCollectionId);
    });
    renderCollectionsNav();

    if (viewName === 'sandbox') {
      viewSandbox.hidden = false;
      viewLibrary.hidden = true;
      libraryTopBar.hidden = true;
    } else {
      viewSandbox.hidden = true;
      viewLibrary.hidden = false;
      libraryTopBar.hidden = false;
      loadLibraryState().then(renderSavedLibraryGrid);
    }
  }

  function renderSavedLibraryGrid() {
    const q = (searchSavedInput.value || '').trim().toLowerCase();
    const sortBy = sortSavedSelect.value;

    let list = [...savedPosts];
    if (currentView === 'collection' && activeCollectionId) {
      const col = collections.find((c) => c.id === activeCollectionId);
      libraryViewTitle.textContent = col ? `Collection: ${col.name}` : 'Collection';
      list = list.filter((p) => (p.collections || []).includes(activeCollectionId));
    } else if (currentView === 'profiles') {
      libraryViewTitle.textContent = 'Saved Posts by Creator Profile';
    } else if (currentView === 'platforms') {
      libraryViewTitle.textContent = 'Saved Posts by Platform';
    } else {
      libraryViewTitle.textContent = 'All Saved Posts';
    }

    if (q) {
      list = list.filter((p) => {
        const hay = [
          p.author,
          p.caption,
          p.notes,
          p.transcript,
          ...(p.tags || [])
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }

    list.sort((a, b) => {
      if (sortBy === 'outlier') return (b.outlierScore || 0) - (a.outlierScore || 0);
      if (sortBy === 'views') return (b.views || 0) - (a.views || 0);
      if (sortBy === 'likes') return (b.likes || 0) - (a.likes || 0);
      if (sortBy === 'comments') return (b.comments || 0) - (a.comments || 0);
      return (b.savedAt || 0) - (a.savedAt || 0);
    });

    if (list.length === 0) {
      savedPostsGrid.innerHTML = `
        <div style="grid-column:1/-1;background:#fff;border:1px solid #e7e5e0;border-radius:14px;padding:36px;text-align:center;">
          <h3 style="font-size:16px;margin-bottom:6px;">No saved posts in this view yet</h3>
          <p style="font-size:13px;color:#85837d;margin-bottom:14px;">
            Bookmark any post from a sorted grid or click "+ Load Sample Swipe File" above to populate sample outlier posts.
          </p>
        </div>
      `;
      return;
    }

    savedPostsGrid.innerHTML = list
      .map(
        (p) => `
        <div class="sf-saved-card" data-saved-id="${escapeHtml(p.id)}">
          <div class="sf-saved-thumb-wrap" data-open-detail="${escapeHtml(p.id)}">
            <img class="sf-saved-thumb" src="${escapeHtml(p.thumbnail)}" alt="" />
            <span class="sf-saved-outlier">⚡ ${p.outlierScore || 1}x</span>
            <span class="sf-saved-views">▶ ${formatNum(p.views)} • ♥ ${formatNum(p.likes)}</span>
          </div>
          <div class="sf-saved-body">
            <div class="sf-saved-creator">@${escapeHtml(p.author || 'creator')} • ${escapeHtml(p.platform || 'instagram')}</div>
            <div class="sf-saved-caption">${escapeHtml(p.caption || '')}</div>
            ${
              (p.tags || []).length > 0
                ? `<div class="sf-tag-row">${p.tags.map((t) => `<span class="sf-tag-chip">#${escapeHtml(t)}</span>`).join('')}</div>`
                : ''
            }
            ${
              p.notes
                ? `<div style="font-size:11.5px;color:#b45309;background:#fffbeb;padding:5px 7px;border-radius:6px;">📝 ${escapeHtml(p.notes)}</div>`
                : ''
            }
            <div class="sf-saved-footer">
              <button type="button" class="sf-mini-btn" data-open-detail="${escapeHtml(p.id)}">Notes & Script</button>
              <button type="button" class="sf-mini-btn" data-download-id="${escapeHtml(p.id)}" title="Download watermark-free video">↓ Video</button>
              <button type="button" class="sf-mini-btn" data-remove-id="${escapeHtml(p.id)}">Remove</button>
            </div>
          </div>
        </div>`
      )
      .join('');

    savedPostsGrid.querySelectorAll('[data-open-detail]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-open-detail');
        const post = savedPosts.find((item) => item.id === id);
        if (post) openSavedDetailModal(post);
      });
    });

    savedPostsGrid.querySelectorAll('[data-download-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-download-id');
        const post = savedPosts.find((item) => item.id === id);
        if (post) {
          window.postMessage({ type: 'SF_DOWNLOAD_SAVED_POSTS', posts: [post] }, '*');
        }
      });
    });

    savedPostsGrid.querySelectorAll('[data-remove-id]').forEach((el) => {
      el.addEventListener('click', async () => {
        const id = el.getAttribute('data-remove-id');
        savedPosts = savedPosts.filter((item) => item.id !== id);
        await storageSet({ sf_saved_posts: savedPosts });
        navCountAll.textContent = String(savedPosts.length);
        renderCollectionsNav();
        renderSavedLibraryGrid();
      });
    });
  }

  function openSavedDetailModal(post) {
    savedDetailBackdrop.hidden = false;
    detailModalBody.innerHTML = `
      <div style="font-size:13px;color:#4b4a46;">
        <strong>@${escapeHtml(post.author)}</strong> • Views: <strong>${formatNum(post.views)}</strong> • Outlier: <strong>${post.outlierScore || 1}x</strong>
      </div>
      <div>
        <label class="sf-form-label">Collection</label>
        <select id="detailColSelect" class="sf-form-input">
          <option value="">None</option>
          ${collections
            .map(
              (c) =>
                `<option value="${c.id}" ${(post.collections || []).includes(c.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
            )
            .join('')}
        </select>
      </div>
      <div>
        <label class="sf-form-label">Tags (comma-separated)</label>
        <input type="text" id="detailTagsInput" class="sf-form-input" value="${escapeHtml((post.tags || []).join(', '))}" placeholder="hook, ai-tool, breakout" />
      </div>
      <div>
        <label class="sf-form-label">Research Notes (why you saved this)</label>
        <textarea id="detailNotesInput" class="sf-form-textarea" placeholder="Write why this hook worked...">${escapeHtml(post.notes || '')}</textarea>
      </div>
      <div>
        <label class="sf-form-label">Transcript</label>
        <textarea id="detailTranscriptInput" class="sf-form-textarea">${escapeHtml(
          post.transcript || `[00:00] ${post.caption || ''} — [00:05] Outlier score ${post.outlierScore || 1}x creator median.`
        )}</textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" id="btnSaveDetailChanges" class="sf-btn-primary">Save Changes</button>
      </div>
    `;

    detailModalBody.querySelector('#btnSaveDetailChanges')?.addEventListener('click', async () => {
      const colId = detailModalBody.querySelector('#detailColSelect')?.value;
      const tagsRaw = detailModalBody.querySelector('#detailTagsInput')?.value || '';
      const notesVal = detailModalBody.querySelector('#detailNotesInput')?.value || '';
      const transVal = detailModalBody.querySelector('#detailTranscriptInput')?.value || '';

      post.collections = colId ? [colId] : [];
      post.tags = tagsRaw
        .split(',')
        .map((t) => t.trim().replace(/^#/, ''))
        .filter(Boolean);
      post.notes = notesVal;
      post.transcript = transVal;

      await chrome.storage.local.set({ sf_saved_posts: savedPosts });
      savedDetailBackdrop.hidden = true;
      renderCollectionsNav();
      renderSavedLibraryGrid();
    });
  }

  btnCloseDetailModal.addEventListener('click', () => {
    savedDetailBackdrop.hidden = true;
  });

  searchSavedInput.addEventListener('input', renderSavedLibraryGrid);
  sortSavedSelect.addEventListener('change', renderSavedLibraryGrid);

  btnNewCollection.addEventListener('click', async () => {
    const name = prompt('New Collection Name (e.g., Hooks to Try, Client A):');
    if (!name || !name.trim()) return;
    collections.push({ id: `col_${Date.now()}`, name: name.trim(), createdAt: Date.now() });
    await storageSet({ sf_collections: collections });
    renderCollectionsNav();
  });

  document.getElementById('btnDownloadSavedZip')?.addEventListener('click', () => {
    if (savedPosts.length === 0) return;
    window.postMessage({ type: 'SF_DOWNLOAD_SAVED_POSTS', posts: savedPosts }, '*');
  });

  btnExportSavedCsv.addEventListener('click', () => {
    if (savedPosts.length === 0) return;
    const headers = ['Creator', 'Platform', 'Link', 'Views', 'OutlierScore', 'Likes', 'Comments', 'Tags', 'Notes', 'Caption'];
    const csv = [
      headers.join(','),
      ...savedPosts.map((p) =>
        [
          `@${p.author || 'creator'}`,
          p.platform || 'instagram',
          p.url || '',
          p.views || 0,
          `${p.outlierScore || 1}x`,
          p.likes || 0,
          p.comments || 0,
          (p.tags || []).join(';'),
          p.notes || '',
          p.caption || ''
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      )
    ].join('\r\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shortfeed_saved_library_${savedPosts.length}.csv`;
    a.click();
  });

  btnSeedSampleSaves.addEventListener('click', async () => {
    const samples = [
      {
        id: 'ig_SF01X100',
        shortcode: 'SF01X100',
        platform: 'instagram',
        author: 'emma.scrapes',
        url: 'https://www.instagram.com/reel/SF01X100/',
        views: 167800,
        likes: 655,
        comments: 8,
        outlierScore: 12.8,
        caption: 'Claude users are living in 2078 😭 Build an AI scraper in 60s',
        tags: ['ai-hook', '10x-outlier'],
        notes: 'Strong visual reaction in first 2 seconds + bold year contrast.',
        collections: ['col_hooks'],
        thumbnail: createMiniThumb('Claude users are living in 2078', '#312e81'),
        savedAt: Date.now()
      },
      {
        id: 'ig_SF02X101',
        shortcode: 'SF02X101',
        platform: 'instagram',
        author: 'emma.scrapes',
        url: 'https://www.instagram.com/reel/SF02X101/',
        views: 153200,
        likes: 590,
        comments: 14,
        outlierScore: 11.7,
        caption: 'Stop writing brittle CSS selectors — use this DOM agent pattern',
        tags: ['negative-hook', 'tutorial'],
        notes: 'Great problem-first opener for developer audience.',
        collections: ['col_outliers'],
        thumbnail: createMiniThumb('Stop writing brittle CSS selectors', '#064e3b'),
        savedAt: Date.now() - 3600000
      }
    ];
    savedPosts = [...samples, ...savedPosts.filter((p) => !samples.some((s) => s.id === p.id))];
    await chrome.storage.local.set({ sf_saved_posts: savedPosts });
    navCountAll.textContent = String(savedPosts.length);
    renderCollectionsNav();
    renderSavedLibraryGrid();
  });

  function createMiniThumb(text, bg) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 520"><rect width="360" height="520" fill="${bg}"/><text x="180" y="250" fill="#fff" font-family="system-ui" font-size="18" font-weight="700" text-anchor="middle">${escapeHtml(text)}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  function formatNum(n) {
    const num = Number(n) || 0;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return String(num);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
});
