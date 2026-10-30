// ShortFeed Background Service Worker (Manifest V3)

const DEFAULT_SETTINGS = {
  openPostsIn: 'player', // 'player' | 'platform'
  showSaveButton: true,
  showDownloadButton: true,
  showTranscribeButton: true,
  playerMuted: false,
  lastScopeTab: 'posts', // 'posts' | 'date'
  lastPostCount: '25',
  lastDateRange: '7d',
  customPostCount: 50,
  customDateStart: '',
  customDateEnd: '',
  plan: 'PRO'
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(['sf_settings', 'sf_saved_posts', 'sf_collections']);
  if (!stored.sf_settings) {
    await chrome.storage.local.set({ sf_settings: DEFAULT_SETTINGS });
  }
  if (!stored.sf_saved_posts) {
    await chrome.storage.local.set({ sf_saved_posts: [] });
  }
  if (!stored.sf_collections) {
    await chrome.storage.local.set({
      sf_collections: [
        { id: 'col_hooks', name: 'Viral Hooks to Try', createdAt: Date.now() },
        { id: 'col_outliers', name: '10x+ Breakout Formats', createdAt: Date.now() },
        { id: 'col_competitors', name: 'Competitor Benchmarks', createdAt: Date.now() }
      ]
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'SF_DOWNLOAD_FILE': {
      const { url, filename } = message.payload || {};
      if (!url) {
        sendResponse({ ok: false, error: 'Missing download URL' });
        return false;
      }
      chrome.downloads.download(
        {
          url,
          filename: sanitizeFilename(filename || 'shortfeed-media.mp4'),
          conflictAction: 'uniquify',
          saveAs: false
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, downloadId });
          }
        }
      );
      return true;
    }

    case 'SF_SAVE_POST': {
      handleSavePost(message.payload).then(sendResponse);
      return true;
    }

    case 'SF_REMOVE_SAVED_POST': {
      handleRemoveSavedPost(message.payload?.id).then(sendResponse);
      return true;
    }

    case 'SF_GET_SAVED_POSTS': {
      chrome.storage.local.get(['sf_saved_posts', 'sf_collections'], (data) => {
        sendResponse({
          ok: true,
          posts: data.sf_saved_posts || [],
          collections: data.sf_collections || []
        });
      });
      return true;
    }

    case 'SF_OPEN_LIBRARY': {
      const targetUrl = chrome.runtime.getURL(
        message.demo ? 'library/library.html?tab=sandbox' : 'library/library.html'
      );
      chrome.tabs.create({ url: targetUrl });
      sendResponse({ ok: true });
      return false;
    }

    case 'SF_OPEN_TAB': {
      if (message.url) {
        chrome.tabs.create({ url: message.url, active: message.active !== false });
      }
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

async function handleSavePost(post) {
  if (!post || !post.id) return { ok: false, error: 'Invalid post payload' };
  const data = await chrome.storage.local.get(['sf_saved_posts']);
  const list = Array.isArray(data.sf_saved_posts) ? data.sf_saved_posts : [];
  const existingIdx = list.findIndex((item) => item.id === post.id);

  const savedRecord = {
    ...post,
    savedAt: Date.now(),
    collections: post.collections || [],
    tags: post.tags || [],
    notes: post.notes || ''
  };

  if (existingIdx >= 0) {
    list[existingIdx] = { ...list[existingIdx], ...savedRecord };
  } else {
    list.unshift(savedRecord);
  }

  await chrome.storage.local.set({ sf_saved_posts: list });
  return { ok: true, count: list.length, saved: savedRecord };
}

async function handleRemoveSavedPost(postId) {
  if (!postId) return { ok: false, error: 'Missing post ID' };
  const data = await chrome.storage.local.get(['sf_saved_posts']);
  const list = Array.isArray(data.sf_saved_posts) ? data.sf_saved_posts : [];
  const next = list.filter((item) => item.id !== postId);
  await chrome.storage.local.set({ sf_saved_posts: next });
  return { ok: true, count: next.length };
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}
