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

const YOUTUBE_VR_UA =
  'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
const YOUTUBE_IOS_UA =
  'com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)';

async function setupYoutubeHeaderRules() {
  if (!chrome?.declarativeNetRequest?.updateDynamicRules) return;
  try {
    const addRules = [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' }
          ]
        },
        condition: {
          urlFilter: '||youtube.com/embed/',
          resourceTypes: ['sub_frame', 'xmlhttprequest', 'other']
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' }
          ]
        },
        condition: {
          urlFilter: '||youtube-nocookie.com/embed/',
          resourceTypes: ['sub_frame', 'xmlhttprequest', 'other']
        }
      },
      {
        id: 3,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: YOUTUBE_VR_UA },
            { header: 'X-YouTube-Client-Name', operation: 'set', value: '28' },
            { header: 'X-YouTube-Client-Version', operation: 'set', value: '1.60.19' },
            { header: 'Origin', operation: 'remove' },
            { header: 'Referer', operation: 'remove' },
            { header: 'Cookie', operation: 'remove' }
          ]
        },
        condition: {
          urlFilter: '||youtube.com/youtubei/v1/player*sf_client=ANDROID_VR',
          resourceTypes: ['xmlhttprequest', 'other']
        }
      },
      {
        id: 4,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: YOUTUBE_IOS_UA },
            { header: 'X-YouTube-Client-Name', operation: 'set', value: '5' },
            { header: 'X-YouTube-Client-Version', operation: 'set', value: '20.03.02' },
            { header: 'Origin', operation: 'remove' },
            { header: 'Referer', operation: 'remove' },
            { header: 'Cookie', operation: 'remove' }
          ]
        },
        condition: {
          urlFilter: '||youtube.com/youtubei/v1/player*sf_client=IOS',
          resourceTypes: ['xmlhttprequest', 'other']
        }
      },
      {
        id: 5,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: YOUTUBE_VR_UA },
            { header: 'Origin', operation: 'remove' },
            { header: 'Referer', operation: 'remove' }
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' }
          ]
        },
        condition: {
          urlFilter: '||googlevideo.com/videoplayback*c=ANDROID_VR',
          resourceTypes: ['media', 'xmlhttprequest', 'other']
        }
      },
      {
        id: 6,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: YOUTUBE_IOS_UA },
            { header: 'Origin', operation: 'remove' },
            { header: 'Referer', operation: 'remove' }
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' }
          ]
        },
        condition: {
          urlFilter: '||googlevideo.com/videoplayback*c=IOS',
          resourceTypes: ['media', 'xmlhttprequest', 'other']
        }
      }
    ];
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2, 3, 4, 5, 6],
      addRules
    });
  } catch {}
}

setupYoutubeHeaderRules();

chrome.runtime.onInstalled.addListener(async () => {
  await setupYoutubeHeaderRules();
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

    case 'SF_RESOLVE_YT_BG': {
      resolveYoutubeStreamInBg(message.payload?.videoId, message.payload?.visitorData)
        .then((videoUrl) => sendResponse({ ok: Boolean(videoUrl), videoUrl: videoUrl || '' }))
        .catch(() => sendResponse({ ok: false, videoUrl: '' }));
      return true;
    }

    case 'SF_DOWNLOAD_VIDEO': {
      handleDownloadVideo(message.payload)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message || 'Download failed' }));
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

    case 'SF_EXPORT_TO_GOOGLE_SHEETS': {
      const payload = message.payload || {};
      chrome.storage.local.set({ sf_pending_sheets_export: payload }, () => {
        chrome.tabs.create({ url: 'https://sheets.new', active: true }, () => {
          sendResponse({ ok: true });
        });
      });
      return true;
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

function extractBgCandidateUrls(playerJson) {
  if (!playerJson || typeof playerJson !== 'object') return [];
  const urls = [];
  const getUrl = (f) => {
    if (f?.url) return f.url;
    const raw = f?.signatureCipher || f?.cipher;
    if (raw && typeof raw === 'string') {
      try {
        const params = new URLSearchParams(raw);
        if (!params.get('s') && params.get('url')) return params.get('url');
      } catch {}
    }
    return '';
  };
  const fmts = playerJson?.streamingData?.formats || [];
  const sortedProg = [...fmts].sort((a, b) => {
    const score = (f) => (f?.itag === 22 ? 3 : f?.itag === 18 ? 2 : /mp4/i.test(f?.mimeType || '') ? 1 : 0);
    return score(b) - score(a);
  });
  sortedProg.forEach((f) => {
    const u = getUrl(f);
    if (u) urls.push(u);
  });
  const adaptive = playerJson?.streamingData?.adaptiveFormats || [];
  adaptive.forEach((f) => {
    if (/video\/mp4/i.test(f?.mimeType || '')) {
      const u = getUrl(f);
      if (u) urls.push(u);
    }
  });
  return Array.from(new Set(urls));
}

async function preflightStreamUrl(url) {
  if (!url || !url.startsWith('http')) return false;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023' }
    });
    try { await res.body?.cancel?.(); } catch {}
    return res.status === 200 || res.status === 206;
  } catch {
    return false;
  }
}

async function resolveYoutubeStreamInBg(videoId, visitorData = '') {
  const vid = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return '';
  const clients = [
    {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      hl: 'en',
      gl: 'US',
      ...(visitorData ? { visitorData } : {})
    },
    {
      clientName: 'IOS',
      clientVersion: '20.03.02',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.2.1.22C161',
      hl: 'en',
      gl: 'US',
      ...(visitorData ? { visitorData } : {})
    }
  ];

  for (const client of clients) {
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?prettyPrint=false&sf_client=${encodeURIComponent(client.clientName)}`,
        {
          method: 'POST',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            videoId: vid,
            contentCheckOk: true,
            racyCheckOk: true,
            context: { client }
          })
        }
      );
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const candidates = extractBgCandidateUrls(json);
      for (const candidateUrl of candidates) {
        if (await preflightStreamUrl(candidateUrl)) {
          return candidateUrl;
        }
      }
    } catch {}
  }
  return '';
}

async function handleDownloadVideo(payload) {
  const { url, videoId, platform, filename } = payload || {};
  let targetUrl = String(url || '').trim();
  if (platform === 'youtube') {
    const validInitial = targetUrl && !/[?&]c=WEB\b/i.test(targetUrl) && (await preflightStreamUrl(targetUrl));
    if (!validInitial) {
      targetUrl = await resolveYoutubeStreamInBg(videoId);
    }
  }
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return { ok: false, error: 'No verified stream URL' };
  }
  return await new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: targetUrl,
        filename: sanitizeFilename(filename || 'shortfeed-video.mp4'),
        conflictAction: 'uniquify',
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError?.message || 'Download failed'
          });
        } else {
          resolve({ ok: true, downloadId, videoUrl: targetUrl });
        }
      }
    );
  });
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'SF_STREAM_YT_DOWNLOAD') return;
  let aborted = false;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => {
    aborted = true;
    try { controller.abort(); } catch {}
  });

  port.onMessage.addListener(async (msg) => {
    if (aborted) return;
    const { url, videoId } = msg || {};
    try {
      let targetUrl = String(url || '').trim();
      const validInitial =
        targetUrl && !/[?&]c=WEB\b/i.test(targetUrl) && (await preflightStreamUrl(targetUrl));
      if (!validInitial) {
        targetUrl = await resolveYoutubeStreamInBg(videoId);
      }
      if (!targetUrl || !targetUrl.startsWith('http')) {
        port.postMessage({ type: 'error', error: 'No verified YouTube stream URL' });
        return;
      }

      const res = await fetch(targetUrl, { signal: controller.signal });
      if (!res.ok || !res.body) {
        port.postMessage({ type: 'error', error: `HTTP ${res.status}` });
        return;
      }

      const total = Number(res.headers.get('content-length')) || 0;
      const mime = res.headers.get('content-type') || 'video/mp4';
      const reader = res.body.getReader();
      let loaded = 0;

      while (true) {
        if (aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          loaded += value.byteLength;
          port.postMessage({
            type: 'chunk',
            b64: uint8ToBase64(value),
            loaded,
            total
          });
        }
      }

      if (!aborted) {
        port.postMessage({ type: 'done', mime, loaded });
      }
    } catch (err) {
      if (!aborted) {
        port.postMessage({ type: 'error', error: err?.message || 'Stream failed' });
      }
    }
  });
});

function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}
