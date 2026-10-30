// ShortFeed Popup Controller

document.addEventListener('DOMContentLoaded', async () => {
  const tabPosts = document.getElementById('tabPosts');
  const tabDate = document.getElementById('tabDate');
  const tabPostsLabel = document.getElementById('tabPostsLabel');
  const panelPosts = document.getElementById('panelPosts');
  const panelDate = document.getElementById('panelDate');
  const selectPostCount = document.getElementById('selectPostCount');
  const selectDateRange = document.getElementById('selectDateRange');
  const customPostWrap = document.getElementById('customPostWrap');
  const inputCustomPosts = document.getElementById('inputCustomPosts');
  const customDateWrap = document.getElementById('customDateWrap');
  const inputDateStart = document.getElementById('inputDateStart');
  const inputDateEnd = document.getElementById('inputDateEnd');

  const platformDot = document.getElementById('platformDot');
  const platformLabel = document.getElementById('platformLabel');
  const btnTryDemoMode = document.getElementById('btnTryDemoMode');

  const btnSortComments = document.getElementById('btnSortComments');
  const btnSortShares = document.getElementById('btnSortShares');
  const btnSortSaves = document.getElementById('btnSortSaves');

  const btnOpenLibrary = document.getElementById('btnOpenLibrary');
  const savedCountBadge = document.getElementById('savedCountBadge');
  const btnToggleSettings = document.getElementById('btnToggleSettings');
  const btnBackFromSettings = document.getElementById('btnBackFromSettings');
  const mainSortView = document.getElementById('mainSortView');
  const settingsView = document.getElementById('settingsView');
  const btnOpenSandboxFull = document.getElementById('btnOpenSandboxFull');

  const settingOpenIn = document.getElementById('settingOpenIn');
  const settingShowSave = document.getElementById('settingShowSave');
  const settingShowDownload = document.getElementById('settingShowDownload');
  const settingShowTranscribe = document.getElementById('settingShowTranscribe');

  let activeTab = null;
  let currentPlatform = 'demo';
  let currentScopeTab = 'posts';

  // Load stored settings & saved count
  const stored = await chrome.storage.local.get(['sf_settings', 'sf_saved_posts']);
  const settings = stored.sf_settings || {
    openPostsIn: 'player',
    showSaveButton: true,
    showDownloadButton: true,
    showTranscribeButton: true,
    lastScopeTab: 'posts',
    lastPostCount: '50',
    lastDateRange: '30d',
    customPostCount: 75
  };

  const savedPosts = Array.isArray(stored.sf_saved_posts) ? stored.sf_saved_posts : [];
  if (savedPosts.length > 0) {
    savedCountBadge.textContent = String(savedPosts.length);
    savedCountBadge.hidden = false;
  }

  // Hydrate controls
  settingOpenIn.value = settings.openPostsIn || 'player';
  settingShowSave.checked = settings.showSaveButton !== false;
  settingShowDownload.checked = settings.showDownloadButton !== false;
  settingShowTranscribe.checked = settings.showTranscribeButton !== false;

  if (settings.lastPostCount) selectPostCount.value = settings.lastPostCount;
  if (settings.lastDateRange) selectDateRange.value = settings.lastDateRange;
  if (settings.customPostCount) inputCustomPosts.value = settings.customPostCount;
  switchScopeTab(settings.lastScopeTab === 'date' ? 'date' : 'posts');

  // Detect active tab & platform
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  const url = activeTab?.url || '';

  if (url.includes('instagram.com')) {
    currentPlatform = 'instagram';
    const isReels = url.includes('/reels');
    platformLabel.textContent = isReels ? 'Instagram • Reels Tab' : 'Instagram • Profile / Feed';
    tabPostsLabel.textContent = isReels ? 'Reels' : 'Posts';
    updatePostLabels(isReels ? 'Reels' : 'Posts');
  } else if (url.includes('tiktok.com')) {
    currentPlatform = 'tiktok';
    platformLabel.textContent = 'TikTok • Videos';
    tabPostsLabel.textContent = 'TikToks';
    updatePostLabels('TikToks');
    btnSortShares.hidden = false;
    btnSortSaves.hidden = false;
  } else if (url.includes('youtube.com')) {
    currentPlatform = 'youtube';
    const isShorts = url.includes('/shorts');
    platformLabel.textContent = isShorts ? 'YouTube • Shorts' : 'YouTube • Channel Videos';
    tabPostsLabel.textContent = isShorts ? 'Shorts' : 'Videos';
    updatePostLabels(isShorts ? 'Shorts' : 'Videos');
    btnSortComments.hidden = true;
  } else if (url.includes('facebook.com')) {
    currentPlatform = 'facebook';
    platformLabel.textContent = 'Facebook • Reels';
    tabPostsLabel.textContent = 'Reels';
    updatePostLabels('Reels');
    btnSortShares.hidden = false;
  } else {
    currentPlatform = 'demo';
    platformDot.classList.add('is-demo');
    platformLabel.textContent = 'Ready • Click any sort for Demo';
  }

  function updatePostLabels(noun) {
    Array.from(selectPostCount.options).forEach((opt) => {
      if (opt.value === 'all') {
        opt.textContent = `All ${noun}`;
      } else if (opt.value === 'custom') {
        opt.textContent = `Custom ${noun}...`;
      } else if (opt.value === '1000') {
        opt.textContent = `Latest 1K ${noun}`;
      } else {
        opt.textContent = `Latest ${opt.value} ${noun}`;
      }
    });
  }

  function switchScopeTab(tabName) {
    currentScopeTab = tabName;
    if (tabName === 'date') {
      tabDate.classList.add('is-active');
      tabPosts.classList.remove('is-active');
      panelDate.hidden = false;
      panelPosts.hidden = true;
    } else {
      tabPosts.classList.add('is-active');
      tabDate.classList.remove('is-active');
      panelPosts.hidden = false;
      panelDate.hidden = true;
    }
    customPostWrap.hidden = selectPostCount.value !== 'custom';
    customDateWrap.hidden = selectDateRange.value !== 'custom';
  }

  tabPosts.addEventListener('click', () => {
    switchScopeTab('posts');
    saveSettingsPatch({ lastScopeTab: 'posts' });
  });

  tabDate.addEventListener('click', () => {
    switchScopeTab('date');
    saveSettingsPatch({ lastScopeTab: 'date' });
  });

  selectPostCount.addEventListener('change', () => {
    customPostWrap.hidden = selectPostCount.value !== 'custom';
    saveSettingsPatch({ lastPostCount: selectPostCount.value });
  });

  selectDateRange.addEventListener('change', () => {
    customDateWrap.hidden = selectDateRange.value !== 'custom';
    saveSettingsPatch({ lastDateRange: selectDateRange.value });
  });

  inputCustomPosts.addEventListener('change', () => {
    saveSettingsPatch({ customPostCount: Number(inputCustomPosts.value) || 50 });
  });

  // Sort button clicks
  document.querySelectorAll('.sf-sort-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const metric = btn.dataset.metric || 'outlier';
      await triggerSort(metric, false);
    });
  });

  // Demo feed button
  btnTryDemoMode.addEventListener('click', async () => {
    await triggerSort('outlier', true);
  });

  async function triggerSort(metric, forceDemo) {
    const postCountVal =
      selectPostCount.value === 'custom'
        ? Number(inputCustomPosts.value) || 50
        : selectPostCount.value === 'all'
        ? 9999
        : Number(selectPostCount.value) || 25;

    const sortOptions = {
      platform: currentPlatform,
      scope: currentScopeTab, // 'posts' | 'date'
      postLimit: postCountVal,
      datePreset: selectDateRange.value,
      dateStart: inputDateStart.value || null,
      dateEnd: inputDateEnd.value || null,
      metric, // 'views' | 'likes' | 'outlier' | 'comments' | 'shares' | 'saves' | 'oldest'
      demoMode: forceDemo || currentPlatform === 'demo'
    };

    if (!activeTab?.id || !activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('edge://')) {
      // Open interactive sandbox page with this sort pre-selected
      const sandboxUrl = chrome.runtime.getURL(
        `library/library.html?tab=sandbox&metric=${encodeURIComponent(metric)}&limit=${encodeURIComponent(postCountVal)}`
      );
      await chrome.tabs.create({ url: sandboxUrl });
      window.close();
      return;
    }

    try {
      await chrome.tabs.sendMessage(activeTab.id, {
        type: 'SF_START_SORT',
        payload: sortOptions
      });
      window.close();
    } catch {
      // Content script not injected yet on this tab — inject dynamically or open sandbox
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: activeTab.id },
          files: ['content/content.css']
        });
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['content/content.js']
        });
        await chrome.tabs.sendMessage(activeTab.id, {
          type: 'SF_START_SORT',
          payload: { ...sortOptions, demoMode: currentPlatform === 'demo' || forceDemo }
        });
        window.close();
      } catch {
        const sandboxUrl = chrome.runtime.getURL(
          `library/library.html?tab=sandbox&metric=${encodeURIComponent(metric)}&limit=${encodeURIComponent(postCountVal)}`
        );
        await chrome.tabs.create({ url: sandboxUrl });
        window.close();
      }
    }
  }

  // Settings navigation
  btnToggleSettings.addEventListener('click', () => {
    const isHidden = settingsView.hidden;
    settingsView.hidden = !isHidden;
    mainSortView.hidden = isHidden;
  });

  btnBackFromSettings.addEventListener('click', () => {
    settingsView.hidden = true;
    mainSortView.hidden = false;
  });

  btnOpenLibrary.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SF_OPEN_LIBRARY', demo: false });
    window.close();
  });

  btnOpenSandboxFull.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SF_OPEN_LIBRARY', demo: true });
    window.close();
  });

  // Platform quick chips
  document.querySelectorAll('.sf-plat-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const targetUrl = chip.dataset.url;
      if (targetUrl) {
        chrome.tabs.create({ url: targetUrl });
        window.close();
      }
    });
  });

  // Settings persistence
  settingOpenIn.addEventListener('change', () => saveSettingsPatch({ openPostsIn: settingOpenIn.value }));
  settingShowSave.addEventListener('change', () => saveSettingsPatch({ showSaveButton: settingShowSave.checked }));
  settingShowDownload.addEventListener('change', () =>
    saveSettingsPatch({ showDownloadButton: settingShowDownload.checked })
  );
  settingShowTranscribe.addEventListener('change', () =>
    saveSettingsPatch({ showTranscribeButton: settingShowTranscribe.checked })
  );

  async function saveSettingsPatch(patch) {
    const data = await chrome.storage.local.get(['sf_settings']);
    const next = { ...(data.sf_settings || {}), ...patch };
    await chrome.storage.local.set({ sf_settings: next });
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, { type: 'SF_SETTINGS_UPDATED', payload: next }).catch(() => {});
    }
  }
});
