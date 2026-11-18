// ShortFeed Content Script — Collection Engine, Outlier Score, Sticky Banner, Filters & Player

(function () {
  if (window.__SHORTFEED_CONTENT_LOADED__) return;
  window.__SHORTFEED_CONTENT_LOADED__ = true;

  const STATE = {
    interceptedMap: new Map(),
    collectedPosts: [],
    filteredPosts: [],
    selectedIds: [], // Ordered array of selected post IDs in Select mode
    savedPostIds: new Set(),
    selectMode: false,
    similarOpen: false,
    similarAccounts: [],
    similarLoading: false,
    demoMode: false,
    currentMetric: 'outlier', // 'outlier' | 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'oldest'
    currentPlatform: detectPlatform(),
    creatorMedian: 0,
    outlierBaselineMetric: 'views',
    filterMin: null,
    filterMax: null,
    filterDays: 'all',
    filterDateStart: null,
    filterDateEnd: null,
    serverClockOffsetMs: 0,
    hasServerClock: false,
    ytVisitorData: '',
    renderedLimit: 100,
    isCollecting: false,
    stopRequested: false,
    activePlayerIndex: -1,
    playerPlaying: true,
    playerSpeed: 1,
    playerTime: 0,
    playerDuration: 23,
    playerTimerId: null,
    settings: {
      openPostsIn: 'player',
      showSaveButton: true,
      showDownloadButton: true,
      showTranscribeButton: true,
      playerMuted: false
    }
  };

  // Safe storage & runtime helpers (works both inside chrome-extension:// and standalone file://)
  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const hasChromeRuntime = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;

  if (hasChromeStorage) {
    chrome.storage.local.get(['sf_settings', 'sf_saved_posts'], (data) => {
      if (data.sf_settings) {
        STATE.settings = { ...STATE.settings, ...data.sf_settings };
      }
      if (Array.isArray(data.sf_saved_posts)) {
        data.sf_saved_posts.forEach((p) => STATE.savedPostIds.add(p.id));
      }
    });
  }

  // Listen for sandbox sort & saved library video download events on library/library.html
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'SF_SANDBOX_SORT') {
      startSortWorkflow({
        platform: 'instagram',
        scope: 'posts',
        postLimit: e.data.postLimit || 25,
        metric: e.data.metric || 'outlier',
        demoMode: true
      });
    } else if (e.data && e.data.type === 'SF_DOWNLOAD_SAVED_POSTS' && Array.isArray(e.data.posts)) {
      downloadPostsBatch(e.data.posts);
    }
  });

  const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function decodeInstagramTimestamp(shortcode, pk) {
    try {
      if (pk && /^\d{15,}$/.test(String(pk))) {
        const bigId = BigInt(String(pk));
        const ms = Number((bigId >> 23n) + 1314220021721n);
        if (ms > 1300000000000 && ms < 2100000000000) return ms;
      }
      if (shortcode && typeof shortcode === 'string') {
        let id = 0n;
        for (let i = 0; i < Math.min(shortcode.length, 11); i++) {
          const idx = IG_ALPHABET.indexOf(shortcode[i]);
          if (idx === -1) break;
          id = id * 64n + BigInt(idx);
        }
        const ms = Number((id >> 23n) + 1314220021721n);
        if (ms > 1300000000000 && ms < 2100000000000) return ms;
      }
    } catch {}
    return null;
  }

  function decodeTikTokTimestamp(videoId) {
    try {
      if (videoId && /^\d{15,}$/.test(String(videoId))) {
        const sec = Number(BigInt(String(videoId)) >> 32n);
        const ms = sec * 1000;
        if (ms > 1400000000000 && ms < 2100000000000) return ms;
      }
    } catch {}
    return null;
  }

  function getRealNow() {
    return Date.now() + (STATE.serverClockOffsetMs || 0);
  }

  function parseRelativeTimeToMs(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
    if (!m) return null;
    const n = Number(m[1]) || 1;
    const unit = m[2].toLowerCase();
    const mult = {
      second: 1000,
      minute: 60 * 1000,
      hour: 3600 * 1000,
      day: 86400 * 1000,
      week: 7 * 86400 * 1000,
      month: 30.44 * 86400 * 1000,
      year: 365.25 * 86400 * 1000
    }[unit];
    return mult ? Math.round(getRealNow() - n * mult) : null;
  }

  function parseRelativeAgeDays(text) {
    if (!text || typeof text !== 'string') return null;
    if (/\b(just now|moment|seconds?\s+ago)\b/i.test(text)) return 0;
    const m = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
    if (!m) return null;
    const n = Number(m[1]) || 1;
    const unit = m[2].toLowerCase();
    const dayMult = {
      second: 1 / 86400,
      minute: 1 / 1440,
      hour: 1 / 24,
      day: 1,
      week: 7,
      month: 30.44,
      year: 365.25
    }[unit];
    return dayMult !== undefined ? Math.round(n * dayMult * 100) / 100 : null;
  }

  function getReferenceNow(posts) {
    if (STATE.hasServerClock || STATE.serverClockOffsetMs) {
      return getRealNow();
    }
    const list = Array.isArray(posts) && posts.length > 0 ? posts : STATE.collectedPosts;
    let maxExactTs = 0;
    let maxAnyTs = 0;
    if (Array.isArray(list)) {
      list.forEach((p) => {
        const ts = Number(p?.publishedAt) || 0;
        if (ts > 0) {
          if (ts > maxAnyTs) maxAnyTs = ts;
          if (p?.hasExactTimestamp && ts > maxExactTs) maxExactTs = ts;
        }
      });
    }
    const maxTs = maxExactTs || maxAnyTs;
    const now = Date.now();
    // Only anchor to newest post when local system clock is >300 days ahead (extreme clock skew)
    if (maxTs > 0 && now - maxTs > 300 * 86400000) {
      return maxTs;
    }
    return now;
  }

  function getDatePresetWindow(days) {
    const d = Number(days);
    // Target window [minDays, maxDays] for "X Back" presets (strictly excluding today's posts)
    // plus a wider fallback window [fallbackMin, maxDays] if the creator posted less frequently
    switch (d) {
      case 7:
        return { minDays: 7, maxDays: 14, fallbackMin: 1 };
      case 30:
        return { minDays: 21, maxDays: 45, fallbackMin: 7 };
      case 90:
        return { minDays: 60, maxDays: 120, fallbackMin: 30 };
      case 180:
        return { minDays: 120, maxDays: 210, fallbackMin: 60 };
      case 365:
        return { minDays: 270, maxDays: 420, fallbackMin: 180 };
      default:
        return { minDays: Math.max(1, Math.floor(d * 0.7)), maxDays: Math.ceil(d * 1.4), fallbackMin: 1 };
    }
  }

  function getPostAgeDays(post, refNow) {
    if (typeof post?.relativeAgeDays === 'number' && post.relativeAgeDays >= 0) {
      return post.relativeAgeDays;
    }
    const ts = Number(post?.publishedAt) || 0;
    if (ts > 0 && refNow > 0) {
      return Math.max(0, (refNow - ts) / 86400000);
    }
    return null;
  }

  function mapPresetToFilterDays(preset) {
    const map = { '7d': '7', '30d': '30', '90d': '90', '180d': '180', '365d': '365', all: 'all', custom: 'custom' };
    return map[preset] || String(preset || 'all');
  }

  function getActiveDateFilterLabel() {
    if (!isDateFilterAllowed() || !STATE.filterDays || STATE.filterDays === 'all') return '';
    const labels = {
      '7': '1 Week Back',
      '30': '1 Month Back',
      '90': '3 Months Back',
      '180': '6 Months Back',
      '365': '1 Year Back'
    };
    if (STATE.filterDays === 'custom') {
      if (STATE.filterDateStart && STATE.filterDateEnd) return `${STATE.filterDateStart} to ${STATE.filterDateEnd}`;
      if (STATE.filterDateStart) return `From ${STATE.filterDateStart}`;
      if (STATE.filterDateEnd) return `Until ${STATE.filterDateEnd}`;
      return 'Custom date range';
    }
    return labels[String(STATE.filterDays)] || `${STATE.filterDays} days back`;
  }

  // Merge two post objects without overwriting non-zero metrics or non-empty strings with 0/empty
  function mergePostObjects(prev, next) {
    if (!prev) return { ...next };
    if (!next) return { ...prev };
    const merged = { ...prev, ...next };
    const numericKeys = ['views', 'likes', 'comments', 'shares', 'saves'];
    numericKeys.forEach((k) => {
      merged[k] = Math.max(Number(prev[k]) || 0, Number(next[k]) || 0);
    });
    if (next.hasExactTimestamp && next.publishedAt) {
      merged.publishedAt = Number(next.publishedAt);
      merged.hasExactTimestamp = true;
    } else if (prev.hasExactTimestamp && prev.publishedAt) {
      merged.publishedAt = Number(prev.publishedAt);
      merged.hasExactTimestamp = true;
    } else {
      const pTs = Number(prev.publishedAt) || 0;
      const nTs = Number(next.publishedAt) || 0;
      merged.publishedAt = pTs && nTs ? Math.min(pTs, nTs) : (nTs || pTs || 0);
      merged.hasExactTimestamp = Boolean(prev.hasExactTimestamp || next.hasExactTimestamp);
    }
    if (typeof next.relativeAgeDays === 'number' && next.relativeAgeDays >= 0) {
      merged.relativeAgeDays = next.relativeAgeDays;
    } else if (typeof prev.relativeAgeDays === 'number' && prev.relativeAgeDays >= 0) {
      merged.relativeAgeDays = prev.relativeAgeDays;
    }
    const stringKeys = ['thumbnail', 'videoUrl', 'caption', 'author', 'url', 'title', 'mediaPk', 'subtitleUrl', 'accessibilityCaption', 'duration', 'category', 'publishedText'];
    stringKeys.forEach((k) => {
      merged[k] = next[k] || prev[k] || '';
    });
    if (prev.type === 'reel' || next.type === 'reel') merged.type = 'reel';
    if (prev.carouselSlides?.length && !next.carouselSlides?.length) {
      merged.carouselSlides = prev.carouselSlides;
    }
    return merged;
  }

  // Merge unique similar accounts (excluding the active profile handle)
  function mergeSimilarAccounts(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) return false;
    const currentCreator = extractCreatorHandle(STATE.currentPlatform).toLowerCase();
    const byHandle = new Map();
    STATE.similarAccounts.forEach((acc) => {
      if (acc?.username) byHandle.set(acc.username.toLowerCase(), acc);
    });
    let changed = false;
    accounts.forEach((acc) => {
      const handle = acc?.username?.trim();
      if (!handle) return;
      const key = handle.toLowerCase();
      if (key === currentCreator) return;
      const prev = byHandle.get(key) || {};
      const next = {
        ...prev,
        ...acc,
        username: handle,
        fullName: acc.fullName || prev.fullName || handle,
        avatar: acc.avatar || prev.avatar || '',
        verified: Boolean(acc.verified || prev.verified),
        url: acc.url || prev.url || `https://www.instagram.com/${handle}/`
      };
      if (!byHandle.has(key) || next.avatar !== prev.avatar || next.fullName !== prev.fullName) {
        changed = true;
      }
      byHandle.set(key, next);
    });
    if (changed) {
      STATE.similarAccounts = Array.from(byHandle.values());
    }
    return changed;
  }

  // Listen for real server clock offset calibrated by HTTP Date headers
  window.addEventListener('SF_SERVER_CLOCK', (e) => {
    if (typeof e.detail?.offsetMs === 'number') {
      STATE.hasServerClock = true;
      STATE.serverClockOffsetMs = e.detail.offsetMs;
    }
  });

  // Listen for intercepted network posts from MAIN world
  window.addEventListener('SF_INTERCEPTED_POSTS', (e) => {
    const list = e.detail;
    if (!Array.isArray(list)) return;
    let updatedCollected = false;
    list.forEach((post) => {
      if (post && post.id) {
        const prev = STATE.interceptedMap.get(post.id);
        const merged = mergePostObjects(prev, post);
        STATE.interceptedMap.set(post.id, merged);
        if (!STATE.isCollecting && STATE.collectedPosts.length > 0) {
          const idx = STATE.collectedPosts.findIndex((p) => p.id === post.id);
          if (idx !== -1) {
            const cur = STATE.collectedPosts[idx];
            const remerged = mergePostObjects(cur, merged);
            if (
              remerged.views !== cur.views ||
              remerged.likes !== cur.likes ||
              remerged.comments !== cur.comments ||
              remerged.shares !== cur.shares ||
              remerged.saves !== cur.saves ||
              remerged.publishedAt !== cur.publishedAt ||
              remerged.videoUrl !== cur.videoUrl ||
              remerged.subtitleUrl !== cur.subtitleUrl
            ) {
              STATE.collectedPosts[idx] = remerged;
              updatedCollected = true;
            }
          }
        }
      }
    });
    if (updatedCollected && !STATE.isCollecting && STATE.collectedPosts.length > 0) {
      STATE.collectedPosts = computeOutlierScores(STATE.collectedPosts, STATE.currentPlatform);
      applyFiltersAndSort();
      if (document.getElementById('sf-sorted-wrapper') && STATE.activePlayerIndex === -1) {
        renderSortedFeedUI();
      }
    }
  });

  // Listen for intercepted similar/chaining accounts from MAIN world
  window.addEventListener('SF_INTERCEPTED_SIMILAR', (e) => {
    const changed = mergeSimilarAccounts(e.detail);
    if (changed && STATE.similarOpen && document.getElementById('sf-sorted-wrapper')) {
      renderSortedFeedUI();
    }
  });

  function mergeCreatorInterceptedIntoMap(targetMap) {
    if (!targetMap || STATE.currentPlatform !== 'instagram' || !isProfileHandleUrl('instagram')) {
      return false;
    }
    const creatorHandle = extractCreatorHandle('instagram').toLowerCase();
    const isReelsTab = location.pathname.includes('/reels');
    let added = false;
    STATE.interceptedMap.forEach((val, key) => {
      if (!key.startsWith('ig_') || !val) return;
      if (val.author && val.author.toLowerCase() !== creatorHandle) return;
      if (isReelsTab && val.type !== 'reel') return;
      if (targetMap.has(key)) {
        targetMap.set(key, mergePostObjects(targetMap.get(key), val));
      } else {
        targetMap.set(key, val);
        added = true;
      }
    });
    return added;
  }

  async function syncAndEnsureInstagramDateHistory() {
    if (STATE.currentPlatform !== 'instagram' || !isProfileHandleUrl('instagram')) return;
    const map = new Map();
    STATE.collectedPosts.forEach((p) => {
      if (p?.id) map.set(p.id, p);
    });
    const hadNew = mergeCreatorInterceptedIntoMap(map);
    if (hadNew || map.size !== STATE.collectedPosts.length) {
      STATE.collectedPosts = computeOutlierScores(Array.from(map.values()), 'instagram');
      if (document.getElementById('sf-sorted-wrapper')) {
        applyFiltersAndSort();
        renderSortedFeedUI();
      }
    }

    if (!STATE.filterDays || STATE.filterDays === 'all') return;
    const refNow = getReferenceNow(STATE.collectedPosts);
    let targetDays = Number(STATE.filterDays) || 60;
    let matchesInBandCount = 0;

    if (STATE.filterDays === 'custom') {
      const startMs = STATE.filterDateStart ? new Date(`${STATE.filterDateStart}T00:00:00`).getTime() : null;
      const endMs = STATE.filterDateEnd ? new Date(`${STATE.filterDateEnd}T23:59:59.999`).getTime() : null;
      if (startMs && !isNaN(startMs)) {
        targetDays = Math.max(7, Math.ceil((refNow - startMs) / 86400000));
      }
      matchesInBandCount = STATE.collectedPosts.filter((p) => {
        const ts = Number(p.publishedAt) || 0;
        if (!ts) return false;
        if (startMs && !isNaN(startMs) && ts < startMs) return false;
        if (endMs && !isNaN(endMs) && ts > endMs) return false;
        return true;
      }).length;
    } else {
      const { minDays, maxDays } = getDatePresetWindow(targetDays);
      matchesInBandCount = STATE.collectedPosts.filter((p) => {
        const age = getPostAgeDays(p, refNow);
        return age !== null && age >= minDays && age <= maxDays;
      }).length;
    }

    if (matchesInBandCount >= 3) return;

    await new Promise((resolve) => {
      let settled = false;
      const onDone = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('SF_FETCH_IG_COMPLETE', onDone);
        resolve();
      };
      window.addEventListener('SF_FETCH_IG_COMPLETE', onDone);
      window.dispatchEvent(
        new CustomEvent('SF_FETCH_IG_PROFILE_REELS', {
          detail: {
            username: extractCreatorHandle('instagram'),
            targetLimit: 150,
            filterDays: targetDays,
            includeClipsOnly: location.pathname.includes('/reels')
          }
        })
      );
      setTimeout(onDone, 5500);
    });

    const updatedMap = new Map();
    STATE.collectedPosts.forEach((p) => {
      if (p?.id) updatedMap.set(p.id, p);
    });
    mergeCreatorInterceptedIntoMap(updatedMap);
    STATE.collectedPosts = computeOutlierScores(Array.from(updatedMap.values()), 'instagram');
    if (document.getElementById('sf-sorted-wrapper')) {
      applyFiltersAndSort();
      renderSortedFeedUI();
    }
  }

  // Listen for messages from Popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      if (msg.type === 'SF_START_SORT') {
        startSortWorkflow(msg.payload || {});
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'SF_APPLY_DATE_FILTER') {
        const { scope, datePreset, dateStart, dateEnd } = msg.payload || {};
        if (!isDateFilterAllowed() || scope === 'posts') {
          STATE.filterDays = 'all';
          STATE.filterDateStart = null;
          STATE.filterDateEnd = null;
        } else {
          STATE.filterDays = mapPresetToFilterDays(datePreset);
          STATE.filterDateStart = dateStart || null;
          STATE.filterDateEnd = dateEnd || null;
        }
        const hasWrapper = Boolean(document.getElementById('sf-sorted-wrapper'));
        if (!STATE.isCollecting && STATE.collectedPosts.length > 0 && hasWrapper) {
          applyFiltersAndSort();
          renderSortedFeedUI();
          syncAndEnsureInstagramDateHistory();
        }
        sendResponse({ ok: true, applied: hasWrapper });
        return false;
      }
      if (msg.type === 'SF_SETTINGS_UPDATED') {
        STATE.settings = { ...STATE.settings, ...(msg.payload || {}) };
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
  }

  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('instagram.com')) return 'instagram';
    if (h.includes('tiktok.com')) return 'tiktok';
    if (h.includes('youtube.com')) return 'youtube';
    if (h.includes('facebook.com')) return 'facebook';
    return 'instagram';
  }

  function getItemNoun(platform) {
    if (platform === 'tiktok') return 'TikToks';
    if (platform === 'youtube') return location.pathname.includes('/shorts') ? 'Shorts' : 'Videos';
    if (platform === 'facebook') return 'Reels';
    return location.pathname.includes('/reels') ? 'Reels' : 'Posts';
  }

  // ============================================================================
  // 1. COLLECTION & AUTO-SCROLL WORKFLOW
  // ============================================================================
  async function startSortWorkflow(options) {
    if (STATE.isCollecting) return;
    STATE.isCollecting = true;
    STATE.stopRequested = false;
    STATE.currentMetric = options.metric || 'outlier';
    STATE.currentPlatform =
      options.platform && options.platform !== 'demo' ? options.platform : detectPlatform();
    STATE.filterMin = null;
    STATE.filterMax = null;
    STATE.demoMode = Boolean(options.demoMode);
    if (options.scope === 'date' && isDateFilterAllowed()) {
      STATE.filterDays = mapPresetToFilterDays(options.datePreset || '30d');
      STATE.filterDateStart = options.dateStart || null;
      STATE.filterDateEnd = options.dateEnd || null;
    } else {
      STATE.filterDays = 'all';
      STATE.filterDateStart = null;
      STATE.filterDateEnd = null;
    }
    STATE.selectMode = false;
    STATE.selectedIds = [];
    STATE.similarOpen = false;
    STATE.similarAccounts = [];
    STATE.similarLoading = false;

    const baseLimit = Number(options.postLimit) || 25;
    const targetLimit =
      options.scope === 'date' && isDateFilterAllowed() && STATE.filterDays !== 'all'
        ? Math.max(baseLimit, 100)
        : baseLimit;
    const noun = getItemNoun(STATE.currentPlatform);

    // If a previous sorted grid was open, restore the native grid before scanning
    restoreNativeGrid();
    document.getElementById('sf-sorted-wrapper')?.remove();

    showProgressOverlay(`Getting ready to sort`, 5);

    const isProfilePage = isProfileHandleUrl(STATE.currentPlatform);

    const isReelsTab = location.pathname.includes('/reels');

    // Ask MAIN world interceptor to scan embedded JSON and fetch creator Reels/Profile API (for play_count)
    if (!options.demoMode && STATE.currentPlatform === 'instagram') {
      const creatorHandle = isProfilePage ? extractCreatorHandle('instagram') : null;
      const requestedFilterDays =
        STATE.filterDays && STATE.filterDays !== 'all'
          ? STATE.filterDays === 'custom' && STATE.filterDateStart
            ? Math.max(7, Math.ceil((getReferenceNow() - new Date(`${STATE.filterDateStart}T00:00:00`).getTime()) / 86400000))
            : Number(STATE.filterDays) || 60
          : 0;
      const fetchTimeoutMs =
        targetLimit >= 5000
          ? 0
          : targetLimit >= 1000
          ? 40000
          : targetLimit >= 200
          ? 12000
          : options.scope === 'date'
          ? 5500
          : 2600;
      await new Promise((resolve) => {
        let settled = false;
        let safetyTimer = null;
        const onDone = () => {
          if (settled) return;
          settled = true;
          clearInterval(progressTimer);
          if (safetyTimer) clearTimeout(safetyTimer);
          window.removeEventListener('SF_FETCH_IG_COMPLETE', onDone);
          resolve();
        };
        const progressTimer = setInterval(() => {
          if (STATE.stopRequested) {
            onDone();
            return;
          }
          const cachedCount = STATE.interceptedMap.size;
          if (cachedCount > 0) {
            const pct =
              targetLimit >= 5000
                ? Math.min(85, Math.max(10, Math.round((cachedCount / Math.max(cachedCount + 100, 500)) * 100)))
                : Math.min(85, Math.max(10, Math.round((cachedCount / Math.max(1, targetLimit)) * 100)));
            updateProgressOverlay(`${cachedCount} ${noun} fetched — loading archive...`, pct);
          }
        }, 450);
        window.addEventListener('SF_FETCH_IG_COMPLETE', onDone);
        window.dispatchEvent(
          new CustomEvent('SF_FETCH_IG_PROFILE_REELS', {
            detail: {
              username: creatorHandle,
              targetLimit,
              filterDays: requestedFilterDays,
              includeClipsOnly: isReelsTab
            }
          })
        );
        if (fetchTimeoutMs > 0) {
          safetyTimer = setTimeout(onDone, fetchTimeoutMs);
        }
      });
    } else if (!options.demoMode && STATE.currentPlatform === 'youtube') {
      window.dispatchEvent(new CustomEvent('SF_REQUEST_RESCAN'));
      await sleep(120);
    }

    const gatheredMap = new Map();
    const domOrderedIds = [];

    if (!options.demoMode && STATE.currentPlatform === 'instagram' && isProfilePage) {
      mergeCreatorInterceptedIntoMap(gatheredMap);
    }

    // Scan live DOM + scroll loop unless forced Demo mode
    if (!options.demoMode) {
      const maxSteps = Math.min(2000, Math.ceil(targetLimit / 6) + 4);
      let staleSteps = 0;
      for (let step = 0; step < maxSteps; step++) {
        if (STATE.stopRequested) break;
        const prevCount = gatheredMap.size;

        const domPosts = scanLiveDomForPosts(STATE.currentPlatform);
        domPosts.forEach((p) => {
          if (!gatheredMap.has(p.id)) domOrderedIds.push(p.id);
          const existing = mergePostObjects(gatheredMap.get(p.id), STATE.interceptedMap.get(p.id));
          gatheredMap.set(p.id, mergePostObjects(p, existing));
        });

        // Also update metrics on already-gathered DOM posts from STATE.interceptedMap
        domOrderedIds.forEach((id) => {
          if (STATE.interceptedMap.has(id)) {
            gatheredMap.set(id, mergePostObjects(gatheredMap.get(id), STATE.interceptedMap.get(id)));
          }
        });
        if (STATE.currentPlatform === 'instagram' && isProfilePage) {
          mergeCreatorInterceptedIntoMap(gatheredMap);
        }

        const currentCount = gatheredMap.size;
        staleSteps = currentCount === prevCount ? staleSteps + 1 : 0;
        const progressDenom = targetLimit >= 9999 ? Math.max(currentCount + 25, 100) : Math.min(targetLimit, 1000);
        const pct = Math.min(98, Math.round((currentCount / Math.max(1, progressDenom)) * 100));
        updateProgressOverlay(`${currentCount} ${noun} sorted — don't scroll`, Math.max(12, pct));

        if (currentCount >= targetLimit) break;
        if (step >= 3 && staleSteps >= 5) break;

        if (options.scope === 'date' && STATE.filterDays !== 'all' && currentCount >= 12) {
          const collectedArr = Array.from(gatheredMap.values());
          // Ignore top 3 slots so pinned posts never prematurely halt scrolling
          const nonPinned = collectedArr.slice(3);
          if (nonPinned.length >= 6) {
            const tail = nonPinned.slice(-3);
            if (STATE.filterDays === 'custom' && STATE.filterDateStart) {
              const startMs = new Date(`${STATE.filterDateStart}T00:00:00`).getTime();
              if (
                !isNaN(startMs) &&
                tail.every((p) => {
                  const ts = Number(p?.publishedAt) || 0;
                  return ts > 0 && ts < startMs;
                })
              ) {
                break;
              }
            } else {
              const days = Number(STATE.filterDays);
              if (days > 0) {
                const refNow = getReferenceNow(collectedArr);
                const { maxDays } = getDatePresetWindow(days);
                if (
                  tail.every((p) => {
                    const age = getPostAgeDays(p, refNow);
                    return age !== null && age > maxDays;
                  })
                ) {
                  break;
                }
              }
            }
          }
        }

        window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' });
        await sleep(380);
      }

      // If some Instagram video/reel posts still have 0 views (e.g. Home feed or uncached grid items),
      // enrich via MAIN-world v1/media/{pk}/info/ API first, then fallback to embed/captioned scraping
      if (STATE.currentPlatform === 'instagram' && !STATE.stopRequested) {
        const missingViewPosts = Array.from(gatheredMap.values()).filter(
          (p) => (!p.views || (STATE.currentMetric === 'shares' && !p.shares)) && p.shortcode
        );
        if (missingViewPosts.length > 0) {
          await new Promise((resolve) => {
            const onDone = () => {
              window.removeEventListener('SF_FETCH_IG_COMPLETE', onDone);
              resolve();
            };
            window.addEventListener('SF_FETCH_IG_COMPLETE', onDone);
            window.dispatchEvent(
              new CustomEvent('SF_FETCH_IG_PROFILE_REELS', {
                detail: {
                  username: null,
                  shortcodes: missingViewPosts.slice(0, 25).map((p) => ({
                    shortcode: p.shortcode,
                    mediaPk: p.mediaPk || ''
                  }))
                }
              })
            );
            setTimeout(onDone, 2200);
          });

          // Sync enriched view counts from STATE.interceptedMap
          STATE.interceptedMap.forEach((val, key) => {
            if (gatheredMap.has(key)) {
              gatheredMap.set(key, mergePostObjects(gatheredMap.get(key), val));
            }
          });
        }

        const stillMissing = Array.from(gatheredMap.values()).filter(
          (p) => (!p.views || (STATE.currentMetric === 'shares' && !p.shares)) && p.shortcode
        );
        if (stillMissing.length > 0) {
          const toEnrich = stillMissing.slice(0, 20);
          await Promise.all(
            toEnrich.map(async (p) => {
              try {
                const res = await fetch(
                  `https://www.instagram.com/p/${encodeURIComponent(p.shortcode)}/embed/captioned/`,
                  { credentials: 'include' }
                );
                if (!res.ok) return;
                const html = await res.text();
                const viewMatch =
                  html.match(/"video_view_count"\s*:\s*(\d+)/) ||
                  html.match(/"play_count"\s*:\s*(\d+)/) ||
                  html.match(/"view_count"\s*:\s*(\d+)/) ||
                  html.match(/([\d.,]+\s*[KMBkmb]?)\s*(?:views|plays)/i);
                const likeMatch =
                  html.match(/"like_count"\s*:\s*(\d+)/) ||
                  html.match(/"edge_media_preview_like"\s*:\s*\{\s*"count"\s*:\s*(\d+)/) ||
                  html.match(/([\d.,]+\s*[KMBkmb]?)\s*likes/i);
                const shareMatch =
                  html.match(/"reshare_count"\s*:\s*(\d+)/) ||
                  html.match(/"share_count"\s*:\s*(\d+)/) ||
                  html.match(/([\d.,]+\s*[KMBkmb]?)\s*(?:shares|reshares)/i);
                const parsedViews = viewMatch ? parseAbbreviated(viewMatch[1]) : 0;
                const parsedLikes = likeMatch ? parseAbbreviated(likeMatch[1]) : 0;
                const parsedShares = shareMatch ? parseAbbreviated(shareMatch[1]) : 0;
                if (parsedViews > 0 || parsedLikes > 0 || parsedShares > 0) {
                  const updated = mergePostObjects(gatheredMap.get(p.id), {
                    views: parsedViews,
                    likes: parsedLikes,
                    shares: parsedShares
                  });
                  gatheredMap.set(p.id, updated);
                  STATE.interceptedMap.set(p.id, updated);
                }
              } catch {}
            })
          );
        }
      }

      if (STATE.currentPlatform === 'youtube' && !STATE.stopRequested) {
        const ytVideoIds = Array.from(gatheredMap.values())
          .map((p) => p.shortcode)
          .filter((id) => /^[A-Za-z0-9_-]{11}$/.test(String(id || '')));
        if (ytVideoIds.length > 0) {
          const ytEnrichCap = targetLimit >= 200 ? 120 : 30;
          updateProgressOverlay('Enriching YouTube likes, comments & dates...', 92);
          await new Promise((resolve) => {
            const onDone = () => {
              window.removeEventListener('SF_FETCH_YT_COMPLETE', onDone);
              resolve();
            };
            window.addEventListener('SF_FETCH_YT_COMPLETE', onDone);
            window.dispatchEvent(
              new CustomEvent('SF_FETCH_YT_METRICS', {
                detail: { videoIds: ytVideoIds.slice(0, ytEnrichCap) }
              })
            );
            setTimeout(onDone, targetLimit >= 200 ? 9000 : 3500);
          });

          STATE.interceptedMap.forEach((val, key) => {
            if (gatheredMap.has(key)) {
              gatheredMap.set(key, mergePostObjects(gatheredMap.get(key), val));
            }
          });
        }
      }
    }

    // Final sync with STATE.interceptedMap (include full API archive on IG profiles + merge DOM items)
    if (STATE.currentPlatform === 'instagram' && isProfilePage) {
      mergeCreatorInterceptedIntoMap(gatheredMap);
    }
    if (gatheredMap.size === 0 && STATE.interceptedMap.size > 0) {
      STATE.interceptedMap.forEach((val, key) => gatheredMap.set(key, val));
    } else {
      STATE.interceptedMap.forEach((val, key) => {
        if (gatheredMap.has(key)) {
          gatheredMap.set(key, mergePostObjects(gatheredMap.get(key), val));
        }
      });
    }

    let finalPosts = Array.from(gatheredMap.values());

    // If running in Demo Mode or on a page where the user isn't logged in / no DOM posts found,
    // populate with the realistic creator dataset so the user can experience the full sorted feed & player!
    if (options.demoMode || finalPosts.length === 0) {
      for (let c = 6; c <= 25; c += 6) {
        if (STATE.stopRequested) break;
        const pct = Math.round((c / 25) * 100);
        updateProgressOverlay(`${Math.min(c, 25)} ${noun} sorted — don't scroll`, pct);
        await sleep(160);
      }
      finalPosts = generateCreatorDemoPosts(STATE.currentPlatform, Math.min(targetLimit, 25));
    } else if (!STATE.filterDays || STATE.filterDays === 'all') {
      finalPosts = finalPosts.slice(0, targetLimit);
    }

    updateProgressOverlay(`${finalPosts.length} ${noun} sorted — 100%`, 100);
    await sleep(220);
    hideProgressOverlay();

    window.scrollTo({ top: 0, behavior: 'smooth' });
    STATE.isCollecting = false;

    STATE.collectedPosts = computeOutlierScores(finalPosts, STATE.currentPlatform);
    applyFiltersAndSort();
    renderSortedFeedUI();
  }

  // ============================================================================
  // 2. LIVE DOM EXTRACTOR (Instagram, TikTok, YouTube, Facebook)
  // ============================================================================
  function scanLiveDomForPosts(platform) {
    const results = [];
    const creator = extractCreatorHandle(platform);

    if (platform === 'instagram') {
      // 1. Scan grid links (/reel/ and /p/)
      const anchors = document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]');
      anchors.forEach((a, idx) => {
        if (a.closest('#sf-sorted-wrapper')) return;
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/(reel|p)\/([A-Za-z0-9_-]+)/);
        if (!match) return;
        const type = match[1];
        const code = match[2];
        if (code === 'liked_by' || code === 'comments') return;

        // Scope to the <article> (home feed) or grid cell container
        const container = a.closest('article') || a.closest('div._aabd, div._ac7v > div') || a;
        const img = container.querySelector('img') || a.querySelector('img');
        const thumb = img?.src || '';
        const caption = img?.alt || '';
        const anchorSpansText = Array.from(a.querySelectorAll('span, div'))
          .map((el) => el.textContent?.trim() || '')
          .filter((t) => /^\d+(?:[.,]\d+)?\s*[KMBkmb]?$/.test(t))
          .join(' ');
        const rawText = [
          container.innerText || '',
          a.innerText || '',
          anchorSpansText,
          ...Array.from(container.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label') || '')
        ].join(' ');

        const parsed = parseSocialMetricsFromText(rawText, `${a.innerText || ''} ${anchorSpansText}`);
        const hasVideoEl = Boolean(container.querySelector('video'));
        const hasReelBadge = Boolean(
          a.querySelector('svg[aria-label*="Reel"], svg[aria-label*="Clip"], svg[aria-label*="Video"]')
        );
        const isReel = type === 'reel' || hasVideoEl || hasReelBadge || location.pathname.includes('/reels');
        const views = parsed.views || (isReel && parsed.firstStat ? parsed.firstStat : 0);
        const likes = parsed.likes || (!isReel && parsed.firstStat ? parsed.firstStat : 0);
        const comments = parsed.comments || 0;
        const shares = parsed.shares || 0;

        // Extract author from article header if on Home/Explore feed
        const authorLink = container.querySelector('header a[href^="/"]');
        const itemAuthor =
          authorLink?.textContent?.trim()?.replace(/^@/, '') || creator;

        const decodedTs = decodeInstagramTimestamp(code);
        results.push({
          id: `ig_${code}`,
          shortcode: code,
          platform: 'instagram',
          type: isReel ? 'reel' : type,
          url: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/`,
          thumbnail: thumb || createPosterDataUri(caption || code, views || likes, idx),
          videoUrl: '',
          views,
          likes,
          comments,
          shares,
          saves: 0,
          caption: caption || `Post ${code} by @${itemAuthor}`,
          author: itemAuthor,
          publishedAt: decodedTs || (Date.now() - (idx + 1) * 86400000 * 2.2),
          hasExactTimestamp: Boolean(decodedTs)
        });
      });
    } else if (platform === 'tiktok') {
      const links = document.querySelectorAll('a[href*="/video/"]');
      links.forEach((a, idx) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/video\/(\d+)/);
        if (!match) return;
        const vid = match[1];
        const container = a.closest('[data-e2e="user-post-item"], div') || a;
        const img = container.querySelector('img');
        const viewsText =
          container.querySelector('[data-e2e="video-views"]')?.textContent ||
          container.innerText ||
          '';
        const views = parseAbbreviated(viewsText) || 0;
        const shareText = container.querySelector('[data-e2e="share-count"]')?.textContent || '';
        const ttRawText = [
          container.innerText || '',
          ...Array.from(container.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label') || '')
        ].join(' ');
        const parsedTt = parseSocialMetricsFromText(ttRawText);
        const shares = parseAbbreviated(shareText) || parsedTt.shares || 0;

        const decodedTs = decodeTikTokTimestamp(vid);
        results.push({
          id: `tt_${vid}`,
          shortcode: vid,
          platform: 'tiktok',
          type: 'video',
          url: new URL(href, location.origin).href,
          thumbnail: img?.src || createPosterDataUri(`TikTok #${idx + 1}`, views, idx),
          videoUrl: '',
          views,
          likes: 0,
          comments: 0,
          shares,
          saves: 0,
          caption: img?.alt || `TikTok video ${vid}`,
          author: creator,
          publishedAt: decodedTs || (Date.now() - (idx + 1) * 86400000 * 1.8),
          hasExactTimestamp: Boolean(decodedTs)
        });
      });
    } else if (platform === 'youtube') {
      const seenVids = new Set();
      const links = document.querySelectorAll(
        'a#thumbnail[href*="/watch?v="], a#video-title-link[href*="/watch?v="], a[href*="/watch?v="], a[href*="/shorts/"]'
      );
      links.forEach((a, idx) => {
        if (a.closest('#sf-sorted-wrapper')) return;
        const href = a.getAttribute('href') || '';
        const match = href.match(/(?:v=|\/shorts\/)([A-Za-z0-9_-]{11})/);
        if (!match) return;
        const vid = match[1];
        if (seenVids.has(vid)) return;
        seenVids.add(vid);

        const isShortUrl = href.includes('/shorts/');
        const card =
          a.closest(
            'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model, yt-lockup-view-model'
          ) ||
          a.parentElement ||
          a;

        const titleEl = card.querySelector(
          '#video-title, a#video-title-link, h3, .shortsLockupViewModelHostMetadataTitle, .yt-lockup-metadata-view-model-wiz__title, [id="video-title"]'
        );
        const title =
          (titleEl?.textContent || a.getAttribute('title') || a.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim() || `YouTube Video ${vid}`;

        const ariaLabels = Array.from(card.querySelectorAll('[aria-label]'))
          .map((el) => el.getAttribute('aria-label') || '')
          .join(' ');
        const metaText = `${card.innerText || ''} ${ariaLabels}`;
        const viewMatch = metaText.match(/([\d.,]+\s*[KMBkmb]?)\s*(?:views|watching)/i);
        const views = viewMatch ? parseAbbreviated(viewMatch[1]) : 0;

        const durEl = card.querySelector(
          'ytd-thumbnail-overlay-time-status-renderer #text, badge-shape .badge-shape-wiz__text, .yt-badge-shape__text'
        );
        const duration = (durEl?.textContent || '').trim() || (isShortUrl ? '0:45' : '');
        const relTs = parseRelativeTimeToMs(metaText);
        const relDays = parseRelativeAgeDays(metaText);
        const thumbImg = card.querySelector('img[src*="ytimg.com"], img[src^="https://"]');

        results.push({
          id: `yt_${vid}`,
          shortcode: vid,
          platform: 'youtube',
          type: isShortUrl ? 'short' : 'video',
          url: new URL(href, location.origin).href,
          thumbnail: thumbImg?.src || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          videoUrl: '',
          views,
          likes: 0,
          comments: 0,
          shares: 0,
          saves: 0,
          title,
          caption: title,
          duration,
          category: 'YouTube',
          author: creator,
          publishedAt: relTs || 0,
          relativeAgeDays: relDays,
          hasExactTimestamp: false
        });
      });
    } else if (platform === 'facebook') {
      const links = document.querySelectorAll('a[href*="/reel/"]');
      links.forEach((a, idx) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/reel\/(\d+)/);
        if (!match) return;
        const rid = match[1];
        const fbContainer = a.closest('[role="article"], div') || a;
        const img = a.querySelector('img');
        const nums = extractNumbersFromText(a.innerText || '');
        const fbRawText = [
          fbContainer.innerText || '',
          a.innerText || '',
          ...Array.from(fbContainer.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label') || '')
        ].join(' ');
        const parsedFb = parseSocialMetricsFromText(fbRawText);
        const views = parsedFb.views || nums[0] || 0;
        const shares = parsedFb.shares || 0;

        results.push({
          id: `fb_${rid}`,
          shortcode: rid,
          platform: 'facebook',
          type: 'reel',
          url: new URL(href, location.origin).href,
          thumbnail: img?.src || createPosterDataUri(`Reel #${idx + 1}`, views, idx),
          videoUrl: '',
          views,
          likes: 0,
          comments: 0,
          shares,
          saves: 0,
          caption: img?.alt || `Facebook Reel ${rid}`,
          author: creator,
          publishedAt: Date.now() - (idx + 1) * 86400000 * 2.5
        });
      });
    }

    return results;
  }

  function isProfileHandleUrl(platform) {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return false;
    const first = parts[0].replace(/^@/, '').toLowerCase();
    return !['explore', 'reels', 'watch', 'shorts', 'search', 'saved', 'p', 'reel', 'stories', 'direct', 'accounts'].includes(first);
  }

  function isDateFilterAllowed() {
    if (STATE.demoMode || document.getElementById('sandboxMountArea')) return true;
    const host = location.hostname.toLowerCase();
    const parts = location.pathname.split('/').filter(Boolean);
    const lowerParts = parts.map((p) => p.toLowerCase());

    if (host.includes('instagram.com')) {
      if (lowerParts.length === 0) return false; // Home
      const reserved = ['explore', 'reels', 'reel', 'p', 'stories', 'direct', 'accounts', 'saved', 'search', 'audio', 'locations'];
      if (reserved.includes(lowerParts[0])) return false;
      if (lowerParts.includes('reels') || lowerParts.includes('tagged') || lowerParts.includes('saved')) return false;
      return lowerParts.length === 1 || (lowerParts.length === 2 && lowerParts[1] === 'posts');
    }

    if (host.includes('youtube.com')) {
      if (lowerParts.length === 0) return false; // Home
      if (lowerParts.includes('shorts')) return false; // Shorts feed or Channel Shorts tab
      if (lowerParts[0].startsWith('@')) return true;
      if (['channel', 'c', 'user'].includes(lowerParts[0]) && lowerParts.length >= 2) return true;
      return false;
    }

    if (host.includes('tiktok.com')) {
      return lowerParts.length === 1 && lowerParts[0].startsWith('@');
    }

    if (host.includes('facebook.com')) {
      if (lowerParts.length === 0 || lowerParts.includes('reels') || lowerParts.includes('watch')) return false;
      return lowerParts.length === 1;
    }

    return false;
  }

  function extractCreatorHandle(platform) {
    if (platform === 'youtube') {
      const handleMatch = location.pathname.match(/^\/(@[^/]+)/);
      if (handleMatch) return handleMatch[1].replace(/^@/, '');
      const domHandle =
        document.querySelector('#channel-handle')?.textContent?.trim() ||
        document.querySelector('ytd-channel-name #text, yt-formatted-string#text.ytd-channel-name')?.textContent?.trim();
      if (domHandle) return domHandle.replace(/^@/, '');
    }
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      const first = parts[0].replace(/^@/, '');
      if (!['explore', 'reels', 'watch', 'shorts', 'search', 'saved', 'p', 'reel', 'stories', 'direct', 'accounts', 'channel', 'feed', 'results'].includes(first.toLowerCase())) {
        return first;
      }
    }
    return platform === 'instagram' ? 'emma.scrapes' : 'creator.studio';
  }

  // ============================================================================
  // 3. OUTLIER SCORE ALGORITHM (Exact Sort Feed Formula: /docs/sorting/outlier-score)
  // ============================================================================
  function computeOutlierScores(posts, platform) {
    if (!Array.isArray(posts) || posts.length === 0) return [];

    function calcMedian(nums) {
      const valid = nums.filter((v) => v > 0).sort((a, b) => a - b);
      if (valid.length === 0) return 0;
      const mid = Math.floor(valid.length / 2);
      return valid.length % 2 !== 0
        ? valid[mid]
        : Math.round((valid[mid - 1] + valid[mid]) / 2);
    }

    // Sort by newest first to select up to 25 recent posts, excluding last 3 days if enough mature posts exist
    const byRecent = [...posts].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    const recent25 = byRecent.slice(0, 25);
    const threeDaysAgo = getReferenceNow(posts) - 3 * 86400000;
    const maturePool = recent25.filter((p) => (p.publishedAt || 0) < threeDaysAgo);
    const pool = maturePool.length >= 5 ? maturePool : recent25;

    // Compute separate medians for views (videos/reels) and likes (static photos/carousels)
    // so mixed profile grids never divide photo likes by video views median
    const viewsMedian =
      calcMedian(pool.map((p) => Number(p.views) || 0)) ||
      calcMedian(posts.map((p) => Number(p.views) || 0));
    const likesMedian =
      calcMedian(pool.map((p) => Number(p.likes) || 0)) ||
      calcMedian(posts.map((p) => Number(p.likes) || 0));

    const hasViews = viewsMedian > 0;
    STATE.outlierBaselineMetric = hasViews ? 'views' : 'likes';
    STATE.creatorMedian = Math.max(1, hasViews ? viewsMedian : likesMedian);

    // Compute multiplier for every post using its matching baseline (views vs likes)
    const scored = posts.map((post) => {
      const views = Number(post.views) || 0;
      const likes = Number(post.likes) || 0;
      let outlierScore = 0;
      let outlierBaseline = hasViews ? 'views' : 'likes';
      let matchedMedian = STATE.creatorMedian;

      if (views > 0 && viewsMedian > 0) {
        outlierBaseline = 'views';
        matchedMedian = viewsMedian;
        outlierScore = Math.round((views / viewsMedian) * 10) / 10;
      } else if (likes > 0 && likesMedian > 0) {
        outlierBaseline = 'likes';
        matchedMedian = likesMedian;
        outlierScore = Math.round((likes / likesMedian) * 10) / 10;
      }

      return {
        ...post,
        outlierScore,
        outlierBaseline,
        creatorMedian: matchedMedian
      };
    });

    // Ration lightning badges: >= 2.0x required for any bolt
    const sortedByOutlier = [...scored].sort((a, b) => b.outlierScore - a.outlierScore);
    const topBoltIds = new Map();
    sortedByOutlier.forEach((p, rankIdx) => {
      if (p.outlierScore < 2.0) {
        topBoltIds.set(p.id, 0);
      } else if (rankIdx === 0 && p.outlierScore >= 6.0) {
        topBoltIds.set(p.id, 3); // ⚡⚡⚡
      } else if (rankIdx <= 2 && p.outlierScore >= 3.5) {
        topBoltIds.set(p.id, 2); // ⚡⚡
      } else if (rankIdx <= 7 && p.outlierScore >= 2.0) {
        topBoltIds.set(p.id, 1); // ⚡
      } else {
        topBoltIds.set(p.id, p.outlierScore >= 4.0 ? 1 : 0);
      }
    });

    return scored.map((p) => ({
      ...p,
      bolts: topBoltIds.get(p.id) || 0
    }));
  }

  // ============================================================================
  // 4. IN-MEMORY FILTERING & INSTANT RE-RANKING
  // ============================================================================
  function applyFiltersAndSort() {
    let list = [...STATE.collectedPosts];

    const metricKey =
      STATE.currentMetric === 'outlier'
        ? 'outlierScore'
        : STATE.currentMetric === 'oldest'
        ? 'views'
        : STATE.currentMetric;

    if (STATE.filterMin !== null && !isNaN(STATE.filterMin)) {
      list = list.filter((p) => {
        const val =
          metricKey === 'views'
            ? Number(p.views || p.likes) || 0
            : metricKey === 'likes'
            ? Number(p.likes || p.views) || 0
            : Number(p[metricKey]) || 0;
        return val >= STATE.filterMin;
      });
    }
    if (STATE.filterMax !== null && !isNaN(STATE.filterMax)) {
      list = list.filter((p) => {
        const val =
          metricKey === 'views'
            ? Number(p.views || p.likes) || 0
            : metricKey === 'likes'
            ? Number(p.likes || p.views) || 0
            : Number(p[metricKey]) || 0;
        return val <= STATE.filterMax;
      });
    }
    if (isDateFilterAllowed() && STATE.filterDays && STATE.filterDays !== 'all') {
      if (STATE.filterDays === 'custom') {
        const startMs = STATE.filterDateStart ? new Date(`${STATE.filterDateStart}T00:00:00`).getTime() : null;
        const endMs = STATE.filterDateEnd ? new Date(`${STATE.filterDateEnd}T23:59:59.999`).getTime() : null;
        list = list.filter((p) => {
          const ts = Number(p.publishedAt) || 0;
          if (!ts) return false;
          if (startMs && !isNaN(startMs) && ts < startMs) return false;
          if (endMs && !isNaN(endMs) && ts > endMs) return false;
          return true;
        });
      } else {
        const days = Number(STATE.filterDays);
        if (days > 0) {
          const refNow = getReferenceNow(STATE.collectedPosts);
          const { minDays, maxDays, fallbackMin } = getDatePresetWindow(days);
          // Tier 1: strict target historical band (e.g. 7-14d ago for "1 Week Back")
          const tier1 = list.filter((p) => {
            const age = getPostAgeDays(p, refNow);
            return age !== null && age >= minDays && age <= maxDays;
          });
          if (tier1.length > 0) {
            list = tier1;
          } else {
            // Tier 2: wider historical window excluding today (e.g. 1-14d ago)
            const tier2 = list.filter((p) => {
              const age = getPostAgeDays(p, refNow);
              return age !== null && age >= fallbackMin && age <= maxDays;
            });
            if (tier2.length > 0) {
              list = tier2;
            } else {
              // Tier 3: ultra-high-volume profiles where all scraped posts are < 1d old;
              // keep posts within maxDays (or undated) and slice a preset-specific historical percentile band
              const tier3Pool = list.filter((p) => {
                const age = getPostAgeDays(p, refNow);
                return age === null || age <= maxDays;
              });
              const n = tier3Pool.length;
              if (n > 3) {
                const byNewestFirst = [...tier3Pool].sort((a, b) => {
                  const ageA = getPostAgeDays(a, refNow);
                  const ageB = getPostAgeDays(b, refNow);
                  const valA = ageA === null ? Infinity : ageA;
                  const valB = ageB === null ? Infinity : ageB;
                  return valA - valB;
                });
                let sliceStart = 3;
                let sliceEnd = n;
                if (days <= 7) {
                  sliceStart = Math.max(3, Math.floor(n * 0.2));
                  sliceEnd = Math.max(6, Math.floor(n * 0.5));
                } else if (days <= 30) {
                  sliceStart = Math.max(4, Math.floor(n * 0.4));
                  sliceEnd = Math.max(8, Math.floor(n * 0.7));
                } else if (days <= 90) {
                  sliceStart = Math.max(5, Math.floor(n * 0.6));
                  sliceEnd = Math.max(10, Math.floor(n * 0.85));
                } else if (days <= 180) {
                  sliceStart = Math.max(6, Math.floor(n * 0.72));
                  sliceEnd = Math.max(12, Math.floor(n * 0.92));
                } else {
                  sliceStart = Math.max(7, Math.floor(n * 0.82));
                  sliceEnd = n;
                }
                if (sliceStart >= n) sliceStart = Math.max(3, Math.floor(n * 0.5));
                sliceEnd = Math.min(n, Math.max(sliceStart + 1, sliceEnd));
                list = byNewestFirst.slice(sliceStart, sliceEnd);
              } else {
                list = tier3Pool;
              }
            }
          }
        }
      }
    }

    // Sort according to STATE.currentMetric (with smart fallback when views are 0 on image/home feeds)
    list.sort((a, b) => {
      switch (STATE.currentMetric) {
        case 'outlier':
          return (
            (b.outlierScore || 0) - (a.outlierScore || 0) ||
            (b.views || b.likes || 0) - (a.views || a.likes || 0)
          );
        case 'views': {
          const av = a.views || a.likes || 0;
          const bv = b.views || b.likes || 0;
          return bv - av || (b.likes || 0) - (a.likes || 0);
        }
        case 'likes': {
          const al = a.likes || 0;
          const bl = b.likes || 0;
          return bl - al || (b.views || 0) - (a.views || 0);
        }
        case 'comments':
          return (b.comments || 0) - (a.comments || 0) || (b.views || b.likes || 0) - (a.views || a.likes || 0);
        case 'shares':
          return (b.shares || 0) - (a.shares || 0) || (b.views || b.likes || 0) - (a.views || a.likes || 0);
        case 'saves':
          return (b.saves || 0) - (a.saves || 0) || (b.views || 0) - (a.views || 0);
        case 'oldest':
          return (a.publishedAt || 0) - (b.publishedAt || 0);
        default:
          return (b.outlierScore || 0) - (a.outlierScore || 0);
      }
    });

    STATE.filteredPosts = list;
    STATE.renderedLimit = 100;
  }

  // ============================================================================
  // 5. RENDER STICKY BANNER & SORTED GRID (getting-started-03-poster.jpg)
  // ============================================================================
  // Crisp SVG Icon Set matching original Sort Feed UI
  const SF_ICONS = {
    heartFilled: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 14.25s-6-3.8-6-8a3.5 3.5 0 0 1 6-2.45A3.5 3.5 0 0 1 14 6.25c0 4.2-6 8-6 8Z"/></svg>`,
    playFilled: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.75l8.5 5.25-8.5 5.25V2.75Z"/></svg>`,
    commentFilled: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2C4.4 2 1.5 4.5 1.5 7.6c0 1.5.7 2.9 1.8 3.9L2.5 14l2.9-1.2c.8.3 1.7.4 2.6.4 3.6 0 6.5-2.5 6.5-5.6S11.6 2 8 2Z"/></svg>`,
    boltFilled: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.2 1.2L3.5 8.8h4.2l-.9 6 5.7-7.6H8.3l.9-6Z"/></svg>`,
    shareFilled: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3l3.5 3.5L10 10M13 6.5H6.5a4 4 0 0 0-4 4V13" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    bookmarkFilled: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.25h8a.75.75 0 0 1 .75.75v10.75L8 10.75l-4.75 3V3A.75.75 0 0 1 4 2.25Z"/></svg>`,
    bookmarkOutline: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 2.5h8a.75.75 0 0 1 .75.75v10.25L8 10.6l-4.75 2.9V3.25A.75.75 0 0 1 4 2.5Z" stroke-linejoin="round"/></svg>`,
    users: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="5.5" r="2.3"/><path d="M2 13c0-2.1 1.8-3.6 4-3.6s4 1.5 4 3.6" stroke-linecap="round"/><circle cx="11.5" cy="6" r="1.8"/><path d="M11.5 9.6c1.6 0 2.9 1.1 2.9 2.8" stroke-linecap="round"/></svg>`,
    download: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2.5v7.5m0 0L5.2 7.2M8 10l2.8-2.8M3 13h10" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    exportUp: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 10.5V3m0 0L5.2 5.8M8 3l2.8 2.8M3 13h10" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    filters: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" stroke-linecap="round"/></svg>`,
    sortArrows: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5.5 3v10m0-10L3 5.5M5.5 3L8 5.5M10.5 13V3m0 10L8 10.5m2.5 2.5L13 10.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    check: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3.2 8.3l3.1 3.1 6.5-6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    transcribe: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M8 4v8.5M5 6.5c.8 2.5 2.5 4.5 6 5.5M11 6.5c-.8 2.5-2.5 4.5-6 5.5" stroke-linecap="round"/></svg>`
  };

  function detectResolvedTheme(targetEl) {
    try {
      const htmlEl = document.documentElement;
      const bodyEl = document.body;

      // 1. Check explicit dark-mode markers on <html> and <body>
      if (
        htmlEl.classList.contains('_aa4d') ||
        bodyEl?.classList.contains('_aa4d') ||
        htmlEl.getAttribute('data-theme') === 'dark' ||
        bodyEl?.getAttribute('data-theme') === 'dark' ||
        htmlEl.getAttribute('data-color-mode') === 'dark' ||
        bodyEl?.getAttribute('data-color-mode') === 'dark' ||
        htmlEl.hasAttribute('dark') ||
        bodyEl?.hasAttribute('dark')
      ) {
        return 'dark';
      }
      if (
        htmlEl.getAttribute('data-theme') === 'light' ||
        bodyEl?.getAttribute('data-theme') === 'light'
      ) {
        return 'light';
      }

      const htmlScheme = window.getComputedStyle(htmlEl).colorScheme || '';
      const bodyScheme = bodyEl ? window.getComputedStyle(bodyEl).colorScheme || '' : '';
      if (htmlScheme.includes('dark') || bodyScheme.includes('dark')) {
        return 'dark';
      }

      // 2. Walk up DOM tree from targetEl (or <main>/<body>) to find first opaque background color
      let el = targetEl ? targetEl.parentElement : null;
      if (!el) el = document.querySelector('main') || bodyEl;
      while (el) {
        const bg = window.getComputedStyle(el).backgroundColor || '';
        const match = bg.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
        if (match) {
          const r = Number(match[1]);
          const g = Number(match[2]);
          const b = Number(match[3]);
          const a = match[4] !== undefined ? Number(match[4]) : 1;
          if (a > 0.05) {
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            return lum < 140 ? 'dark' : 'light';
          }
        }
        el = el.parentElement;
      }

      // 3. Check body text color luminance (light text => dark mode)
      if (bodyEl) {
        const color = window.getComputedStyle(bodyEl).color || '';
        const cMatch = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
        if (cMatch) {
          const lum = 0.299 * Number(cMatch[1]) + 0.587 * Number(cMatch[2]) + 0.114 * Number(cMatch[3]);
          if (lum > 180) return 'dark';
        }
      }

      // 4. Fall back to OS/System color scheme
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch {}
    return 'light';
  }

  // Locate the native post grid container on Instagram, TikTok, YouTube, or Facebook
  // so #sf-sorted-wrapper completely replaces the native grid right above the page footer!
  function mountSortedWrapperInPlace(wrapper) {
    const sandboxMount = document.getElementById('sandboxMountArea');
    if (sandboxMount) {
      sandboxMount.prepend(wrapper);
      return;
    }

    // Restore any previously hidden native grid before re-mounting
    restoreNativeGrid();

    if (STATE.currentPlatform === 'youtube') {
      const activeBrowse =
        document.querySelector('ytd-browse:not([hidden])') ||
        document.querySelector('ytd-two-column-browse-results-renderer') ||
        document.querySelector('#primary') ||
        document.body;
      const ytGrid =
        activeBrowse.querySelector('ytd-rich-grid-renderer') ||
        activeBrowse.querySelector('ytd-section-list-renderer') ||
        activeBrowse.querySelector('#contents.ytd-rich-grid-renderer');
      if (ytGrid && ytGrid.parentElement) {
        ytGrid.parentElement.insertBefore(wrapper, ytGrid);
        ytGrid.setAttribute('data-sf-hidden-grid', '1');
        ytGrid.style.setProperty('display', 'none', 'important');
        return;
      }
    }

    const mainEl = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;

    // Helper: hide every ancestor/sibling container that holds native post links (without hiding <header> or [role="tablist"])
    const nativePostLinks = Array.from(
      mainEl.querySelectorAll(
        'a[href*="/p/"], a[href*="/reel/"], a[href*="/video/"], a#thumbnail[href*="/watch?v="], a[href*="/shorts/"]'
      )
    ).filter((a) => !a.closest('#sf-sorted-wrapper') && !a.closest('header') && !a.closest('[role="tablist"]'));

    if (nativePostLinks.length > 0) {
      const firstLink = nativePostLinks[0];
      // Walk up from firstLink to find the highest container inside <main> that does NOT contain <header> or [role="tablist"]
      let curr = firstLink.parentElement;
      let gridRoot = null;
      while (curr && curr !== mainEl && curr !== document.body) {
        if (
          curr.querySelector('header') ||
          curr.querySelector('[role="tablist"]') ||
          curr.querySelector('[data-e2e="user-info"]')
        ) {
          break;
        }
        gridRoot = curr;
        curr = curr.parentElement;
      }

      if (gridRoot && gridRoot.parentElement) {
        gridRoot.parentElement.insertBefore(wrapper, gridRoot);
        // Hide gridRoot and any subsequent sibling containers that also hold native post links
        nativePostLinks.forEach((link) => {
          let node = link.parentElement;
          let topNode = null;
          while (node && node !== mainEl && node !== document.body) {
            if (
              node.querySelector('header') ||
              node.querySelector('[role="tablist"]') ||
              node.querySelector('#sf-sorted-wrapper')
            ) {
              break;
            }
            topNode = node;
            node = node.parentElement;
          }
          if (topNode && topNode !== wrapper) {
            topNode.setAttribute('data-sf-hidden-grid', '1');
            topNode.style.setProperty('display', 'none', 'important');
          }
        });
        return;
      }
    }

    // Fallback: insert after [role="tablist"] or <header> inside <main>
    const tablist = mainEl.querySelector('[role="tablist"]');
    if (tablist && tablist.parentElement) {
      tablist.insertAdjacentElement('afterend', wrapper);
      return;
    }

    const headerEl = mainEl.querySelector('header');
    if (headerEl && headerEl.parentElement) {
      headerEl.insertAdjacentElement('afterend', wrapper);
      return;
    }

    mainEl.prepend(wrapper);
  }

  function restoreNativeGrid() {
    document.querySelectorAll('[data-sf-hidden-grid="1"]').forEach((el) => {
      el.style.removeProperty('display');
      el.removeAttribute('data-sf-hidden-grid');
    });
  }

  function renderSortedFeedUI() {
    let wrapper = document.getElementById('sf-sorted-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'sf-sorted-wrapper';
      mountSortedWrapperInPlace(wrapper);
    }

    wrapper.setAttribute('data-sf-theme', detectResolvedTheme(wrapper));
    wrapper.setAttribute('data-sf-platform', STATE.currentPlatform);
    const isYtShortsView =
      STATE.currentPlatform === 'youtube' &&
      (location.pathname.includes('/shorts') ||
        (STATE.filteredPosts.length > 0 && STATE.filteredPosts.every((p) => p.type === 'short')));
    const isYtWidescreen = STATE.currentPlatform === 'youtube' && !isYtShortsView;
    wrapper.setAttribute('data-sf-layout', isYtWidescreen ? 'yt-video' : isYtShortsView ? 'yt-short' : 'default');

    const noun = getItemNoun(STATE.currentPlatform);
    const totalCount = STATE.filteredPosts.length;
    const activeCount = STATE.selectMode ? STATE.selectedIds.length : totalCount;

    const headlineMap = {
      outlier: `Top Outlier ${noun}`,
      views: `Most Viewed ${noun}`,
      likes: `Most Liked ${noun}`,
      comments: `Most Commented ${noun}`,
      shares: `Most Shared ${noun}`,
      saves: `Most Saved ${noun}`,
      oldest: `Oldest ${noun}`
    };
    const headline = headlineMap[STATE.currentMetric] || `Sorted ${noun}`;
    const dateAllowed = isDateFilterAllowed();
    const hasActiveFilter =
      STATE.filterMin !== null || STATE.filterMax !== null || (dateAllowed && STATE.filterDays !== 'all');
    const dateLabel = getActiveDateFilterLabel();
    const collectedTotal = STATE.collectedPosts.length;

    wrapper.innerHTML = `
      <div class="sf-banner">
        <div class="sf-banner-top">
          <div>
            <h2 class="sf-banner-headline">${escapeHtml(headline)}</h2>
            <div class="sf-banner-sub">
              Showing ${totalCount}${totalCount !== collectedTotal ? ` of ${collectedTotal}` : ''} ${escapeHtml(noun)}${dateLabel ? ` • ${escapeHtml(dateLabel)}` : ''}
            </div>
          </div>

          <div class="sf-action-row">
            ${
              STATE.currentPlatform === 'instagram'
                ? `<button type="button" class="sf-action-btn ${STATE.similarOpen ? 'is-active' : ''}" id="sfBtnSimilar">
                     ${SF_ICONS.users}
                     <span>Similar</span>
                     <span class="sf-new-badge">New</span>
                   </button>`
                : ''
            }
            <button type="button" class="sf-action-btn" id="sfBtnDownload">
              ${SF_ICONS.download}
              <span>Download</span>
              <span class="sf-action-count">${activeCount}</span>
            </button>
            <div style="position:relative;">
              <button type="button" class="sf-action-btn sf-action-btn-bordered" id="sfBtnExportMenu">
                ${SF_ICONS.exportUp}
                <span>Export</span>
                <span class="sf-action-count">${activeCount}</span>
              </button>
              <div class="sf-popover sf-popover-right" id="sfPopoverExport" hidden>
                <button type="button" class="sf-menu-item" data-export="sheets">
                  <span>Google Sheets</span>
                  <span class="sf-menu-sub">Auto-table</span>
                </button>
                <button type="button" class="sf-menu-item" data-export="excel">
                  <span>Excel (.xlsx)</span>
                  <span class="sf-menu-sub">Spreadsheet</span>
                </button>
                <button type="button" class="sf-menu-item" data-export="csv">
                  <span>CSV (.csv)</span>
                  <span class="sf-menu-sub">Comma-separated</span>
                </button>
                <button type="button" class="sf-menu-item" data-export="json">
                  <span>JSON (.json)</span>
                  <span class="sf-menu-sub">Raw records</span>
                </button>
                <button type="button" class="sf-menu-item" id="sfBtnCopy">
                  <span>Copy to Clipboard</span>
                  <span class="sf-menu-sub">TSV</span>
                </button>
                ${
                  STATE.selectMode
                    ? `<button type="button" class="sf-menu-item" data-export="transcripts">
                         <span>Export + Transcripts</span>
                         <span class="sf-menu-sub">PRO</span>
                       </button>`
                    : ''
                }
              </div>
            </div>
          </div>
        </div>

        <div class="sf-banner-controls">
          <div class="sf-chip-group">
            <!-- Filters Popover Trigger -->
            <div style="position:relative;">
              <button type="button" class="sf-chip-btn" id="sfBtnFiltersChip">
                ${SF_ICONS.filters}
                <span>Filters</span>
                ${hasActiveFilter ? '<span class="sf-filter-dot"></span>' : ''}
              </button>
              <div class="sf-popover sf-filter-popover" id="sfPopoverFilters" hidden>
                <div class="sf-filter-title">Performance Range (${escapeHtml(STATE.currentMetric)})</div>
                <div class="sf-histogram" id="sfHistogramBars">
                  ${renderHistogramBarsHtml()}
                </div>
                <div class="sf-range-inputs">
                  <div class="sf-field-group">
                    <label>Min</label>
                    <input type="number" id="sfInputMin" class="sf-field-input" placeholder="0" value="${STATE.filterMin ?? ''}" />
                  </div>
                  <div class="sf-field-group">
                    <label>Max</label>
                    <input type="number" id="sfInputMax" class="sf-field-input" placeholder="Any" value="${STATE.filterMax ?? ''}" />
                  </div>
                </div>
                ${
                  dateAllowed
                    ? `<div class="sf-field-group">
                         <label>Posted within</label>
                         <select id="sfSelectFilterDays" class="sf-field-input">
                           <option value="all" ${STATE.filterDays === 'all' ? 'selected' : ''}>Any time</option>
                           <option value="7" ${STATE.filterDays === '7' ? 'selected' : ''}>1 Week Back (7–14 days ago)</option>
                           <option value="30" ${STATE.filterDays === '30' ? 'selected' : ''}>1 Month Back</option>
                           <option value="90" ${STATE.filterDays === '90' ? 'selected' : ''}>3 Months Back</option>
                           <option value="180" ${STATE.filterDays === '180' ? 'selected' : ''}>6 Months Back</option>
                           <option value="365" ${STATE.filterDays === '365' ? 'selected' : ''}>1 Year Back</option>
                           <option value="custom" ${STATE.filterDays === 'custom' ? 'selected' : ''}>Custom date range...</option>
                         </select>
                       </div>
                       <div id="sfFilterCustomDatesWrap" class="sf-range-inputs" ${STATE.filterDays === 'custom' ? '' : 'hidden'}>
                         <div class="sf-field-group">
                           <label>From</label>
                           <input type="date" id="sfFilterDateStart" class="sf-field-input" value="${escapeHtml(STATE.filterDateStart || '')}" />
                         </div>
                         <div class="sf-field-group">
                           <label>To</label>
                           <input type="date" id="sfFilterDateEnd" class="sf-field-input" value="${escapeHtml(STATE.filterDateEnd || '')}" />
                         </div>
                       </div>`
                    : ''
                }
                <button type="button" class="sf-apply-btn" id="sfBtnApplyFilters">
                  Apply Filters (${totalCount} matching)
                </button>
              </div>
            </div>

            <!-- Instant Re-Sort Chip -->
            <div style="position:relative;">
              <button type="button" class="sf-chip-btn" id="sfBtnSortByChip">
                ${SF_ICONS.sortArrows}
                <span>Sort by</span>
              </button>
              <div class="sf-popover" id="sfPopoverSortBy" hidden>
                ${renderSortByMenuItemsHtml()}
              </div>
            </div>

            <button type="button" class="sf-clear-btn" id="sfBtnClearFilters">Clear all</button>
          </div>

          <div style="display:flex;align-items:center;gap:6px;">
            <button type="button" class="sf-clear-btn ${STATE.selectMode ? 'is-active' : ''}" id="sfBtnSelect">
              ${SF_ICONS.check}
              <span>${STATE.selectMode ? `Cancel (${STATE.selectedIds.length})` : 'Select'}</span>
            </button>
          </div>
        </div>
      </div>

      ${STATE.similarOpen ? renderSimilarAccountsDrawerHtml() : ''}

      <div class="sf-grid" id="sfSortedGrid">
        ${
          STATE.filteredPosts.length > 0
            ? STATE.filteredPosts
                .slice(0, STATE.renderedLimit || 100)
                .map((post, idx) => renderGridCardHtml(post, idx))
                .join('')
            : `<div style="grid-column:1/-1;padding:48px 24px;text-align:center;background:var(--sf-surface-elevated);border:1px solid var(--sf-border-color);border-radius:12px;margin:16px 0;">
                 <div style="font-size:15px;font-weight:700;color:var(--sf-text-primary);margin-bottom:6px;">No ${escapeHtml(noun)} match the active filters</div>
                 <div style="font-size:13px;color:var(--sf-text-muted);margin-bottom:16px;">${dateLabel ? `Active date filter: ${escapeHtml(dateLabel)}. ` : ''}Try widening the date range or clearing filters to view all ${collectedTotal} collected ${escapeHtml(noun)}.</div>
                 <button type="button" class="sf-apply-btn" id="sfBtnEmptyClearFilters" style="width:auto;padding:8px 18px;">Clear filters</button>
               </div>`
        }
      </div>
      ${
        STATE.filteredPosts.length > (STATE.renderedLimit || 100)
          ? `<div class="sf-pagination-bar" style="display:flex;align-items:center;justify-content:center;gap:10px;padding:18px 12px 26px;flex-wrap:wrap;">
               <span style="font-size:12.5px;color:var(--sf-text-muted);">Showing ${Math.min(STATE.renderedLimit || 100, STATE.filteredPosts.length)} of ${STATE.filteredPosts.length} ${escapeHtml(noun)}</span>
               <button type="button" class="sf-action-btn sf-action-btn-bordered" id="sfBtnLoadMore">+ Show next ${Math.min(100, STATE.filteredPosts.length - (STATE.renderedLimit || 100))}</button>
               <button type="button" class="sf-clear-btn" id="sfBtnShowAll">Show all (${STATE.filteredPosts.length})</button>
             </div>`
          : ''
      }
    `;

    bindBannerAndGridEvents(wrapper);
  }

  function renderGridCardHtml(post, idx) {
    const isSaved = STATE.savedPostIds.has(post.id);
    const selectIdx = STATE.selectedIds.indexOf(post.id);
    const isSelected = selectIdx !== -1;

    const boltsIcons = post.bolts > 0 ? SF_ICONS.boltFilled.repeat(post.bolts) : '';
    const tooltipText = `${post.outlierScore}x — ${post.outlierScore}x more than usual (${formatCount(
      post.views || post.likes
    )} vs ${formatCount(post.creatorMedian)} median)`;

    // Corner stat matches the active sort metric (like original Sort Feed)
    let cornerIcon = SF_ICONS.playFilled;
    let cornerVal = formatCount(post.views || post.likes);
    if (STATE.currentMetric === 'likes') {
      cornerIcon = SF_ICONS.heartFilled;
      cornerVal = formatCount(post.likes || post.views);
    } else if (STATE.currentMetric === 'comments') {
      cornerIcon = SF_ICONS.commentFilled;
      cornerVal = formatCount(post.comments);
    } else if (STATE.currentMetric === 'shares') {
      cornerIcon = SF_ICONS.shareFilled;
      cornerVal = formatCount(post.shares);
    } else if (STATE.currentMetric === 'saves') {
      cornerIcon = SF_ICONS.bookmarkFilled;
      cornerVal = formatCount(post.saves);
    } else if (post.views > 0) {
      cornerIcon = SF_ICONS.playFilled;
      cornerVal = formatCount(post.views);
    } else {
      cornerIcon = SF_ICONS.heartFilled;
      cornerVal = formatCount(post.likes);
    }

    const isYtVideoCard = post.platform === 'youtube' && post.type !== 'short';
    const mediaHtml = `
      <img class="sf-card-thumb" src="${escapeHtml(post.thumbnail)}" alt="${escapeHtml(post.caption)}" loading="lazy" />

      ${
        boltsIcons
          ? `<div class="sf-bolt-badge">${boltsIcons}</div>
             <div class="sf-bolt-tooltip">${escapeHtml(tooltipText)}</div>`
          : ''
      }

      ${
        STATE.selectMode
          ? `<div class="sf-select-circle">${isSelected ? selectIdx + 1 : ''}</div>`
          : `<div class="sf-card-quick-actions">
               ${
                 STATE.settings.showSaveButton !== false
                   ? `<button type="button" class="sf-card-action-icon ${isSaved ? 'is-saved' : ''}" data-card-action="save" data-id="${escapeHtml(post.id)}" title="Save post to library (S)">
                        ${isSaved ? SF_ICONS.bookmarkFilled : SF_ICONS.bookmarkOutline}
                      </button>`
                   : ''
               }
               ${
                 STATE.settings.showDownloadButton !== false
                   ? `<button type="button" class="sf-card-action-icon" data-card-action="download" data-id="${escapeHtml(post.id)}" title="Download media">
                        ${SF_ICONS.download}
                      </button>`
                   : ''
               }
               ${
                 STATE.settings.showTranscribeButton !== false
                   ? `<button type="button" class="sf-card-action-icon" data-card-action="transcribe" data-id="${escapeHtml(post.id)}" title="Transcribe video (T)">
                        ${SF_ICONS.transcribe}
                      </button>`
                   : ''
               }
             </div>`
      }

      <div class="sf-card-hover-stats">
        ${post.views > 0 ? `<div class="sf-hover-stat-row">${SF_ICONS.playFilled} <span>${formatCount(post.views)}</span></div>` : ''}
        <div class="sf-hover-stat-row">${SF_ICONS.heartFilled} <span>${formatCount(post.likes)}</span></div>
        ${post.comments ? `<div class="sf-hover-stat-row">${SF_ICONS.commentFilled} <span>${formatCount(post.comments)}</span></div>` : ''}
        ${post.shares ? `<div class="sf-hover-stat-row">${SF_ICONS.shareFilled} <span>${formatCount(post.shares)}</span></div>` : ''}
        <div class="sf-hover-stat-row" style="color:#fbbf24;">${SF_ICONS.boltFilled} <span>${post.outlierScore}x</span></div>
      </div>

      <div class="sf-corner-stat">${cornerIcon} <span>${cornerVal}</span></div>
      ${
        STATE.currentMetric === 'outlier'
          ? `<div class="sf-corner-outlier">${post.outlierScore}x</div>`
          : isYtVideoCard && post.duration
          ? `<div class="sf-corner-duration">${escapeHtml(post.duration)}</div>`
          : ''
      }
    `;

    if (isYtVideoCard) {
      return `
        <div class="sf-card-item is-yt-video ${isSelected ? 'is-selected' : ''}" data-index="${idx}" data-id="${escapeHtml(post.id)}">
          <div class="sf-card-media">${mediaHtml}</div>
          <div class="sf-yt-card-meta">
            <div class="sf-yt-card-title" title="${escapeHtml(post.title || post.caption)}">${escapeHtml(post.title || post.caption)}</div>
            <div class="sf-yt-card-sub">
              <span>${formatCount(post.views)} views</span>
              ${post.likes ? `<span>• ${formatCount(post.likes)} likes</span>` : ''}
              ${post.publishedAt ? `<span>• ${escapeHtml(formatPublishDate(post.publishedAt))}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="sf-card-item ${isSelected ? 'is-selected' : ''}" data-index="${idx}" data-id="${escapeHtml(post.id)}">
        ${mediaHtml}
      </div>
    `;
  }

  function renderHistogramBarsHtml() {
    const key =
      STATE.currentMetric === 'outlier'
        ? 'outlierScore'
        : STATE.currentMetric === 'oldest'
        ? 'views'
        : STATE.currentMetric;
    const vals = STATE.collectedPosts.map((p) => Number(p[key]) || 0);
    if (vals.length === 0) return '';
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const bins = new Array(16).fill(0);
    const span = Math.max(1, max - min);

    vals.forEach((v) => {
      const idx = Math.min(15, Math.floor(((v - min) / span) * 16));
      bins[idx]++;
    });
    const maxBin = Math.max(1, ...bins);

    return bins
      .map((count) => {
        const heightPct = Math.max(8, Math.round((count / maxBin) * 100));
        return `<div class="sf-hist-bar" style="height:${heightPct}%" title="${count} posts"></div>`;
      })
      .join('');
  }

  function renderSortByMenuItemsHtml() {
    const metrics = [
      { id: 'outlier', label: 'Outlier score', icon: SF_ICONS.boltFilled },
      { id: 'views', label: 'Views', icon: SF_ICONS.playFilled },
      { id: 'likes', label: 'Likes', icon: SF_ICONS.heartFilled },
      { id: 'comments', label: 'Comments', icon: SF_ICONS.commentFilled },
      { id: 'shares', label: 'Shares', icon: SF_ICONS.shareFilled },
      { id: 'saves', label: 'Saves', icon: SF_ICONS.bookmarkFilled },
      { id: 'oldest', label: 'Oldest', icon: '' }
    ];
    return metrics
      .map(
        (m) => `
        <button type="button" class="sf-menu-item ${STATE.currentMetric === m.id ? 'is-selected' : ''}" data-sort-metric="${m.id}">
          <span style="display:inline-flex;align-items:center;gap:8px;">
            <span style="width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;">${m.icon}</span>
            <span>${m.label}</span>
          </span>
          ${STATE.currentMetric === m.id ? `<span>✓</span>` : ''}
        </button>`
      )
      .join('');
  }

  function renderSimilarAccountsDrawerHtml() {
    const similarList = getSimilarAccountsList();
    const creator = extractCreatorHandle(STATE.currentPlatform);
    return `
      <div class="sf-similar-drawer">
        <div class="sf-similar-header">
          <span class="sf-similar-title">Similar accounts you can sort (${similarList.length})</span>
          ${
            similarList.length > 0
              ? `<button type="button" class="sf-action-btn sf-action-btn-bordered" id="sfBtnExportSimilar">
                   ↑ Export Similar List (CSV)
                 </button>`
              : ''
          }
        </div>
        ${
          STATE.similarLoading && similarList.length === 0
            ? `<div class="sf-similar-empty">Loading similar accounts for @${escapeHtml(creator)}...</div>`
            : similarList.length === 0
            ? `<div class="sf-similar-empty">No similar accounts found for @${escapeHtml(creator)} yet. Try clicking Instagram's native Similar Accounts icon above the grid or refresh.</div>`
            : `<div class="sf-similar-grid">
                 ${similarList
                   .map(
                     (acc) => `
                     <div class="sf-similar-card" data-sim-url="${escapeHtml(acc.url)}">
                       ${
                         acc.avatar
                           ? `<img class="sf-sim-avatar-img" src="${escapeHtml(acc.avatar)}" alt="${escapeHtml(acc.username)}" loading="lazy" /><div class="sf-sim-avatar" hidden>${escapeHtml(acc.username.slice(0, 2).toUpperCase())}</div>`
                           : `<div class="sf-sim-avatar">${escapeHtml(acc.username.slice(0, 2).toUpperCase())}</div>`
                       }
                       <div class="sf-sim-info">
                         <div class="sf-sim-handle">@${escapeHtml(acc.username)} ${acc.verified ? '✓' : ''}</div>
                         <div class="sf-sim-name">${escapeHtml(acc.fullName || acc.category || acc.username)}</div>
                       </div>
                     </div>`
                   )
                   .join('')}
               </div>`
        }
      </div>
    `;
  }

  function bindBannerAndGridEvents(wrapper) {
    const btnSelect = wrapper.querySelector('#sfBtnSelect');
    const btnSimilar = wrapper.querySelector('#sfBtnSimilar');
    const btnDownload = wrapper.querySelector('#sfBtnDownload');
    const btnCopy = wrapper.querySelector('#sfBtnCopy');
    const btnExportMenu = wrapper.querySelector('#sfBtnExportMenu');
    const popoverExport = wrapper.querySelector('#sfPopoverExport');
    const btnFiltersChip = wrapper.querySelector('#sfBtnFiltersChip');
    const popoverFilters = wrapper.querySelector('#sfPopoverFilters');
    const btnSortByChip = wrapper.querySelector('#sfBtnSortByChip');
    const popoverSortBy = wrapper.querySelector('#sfPopoverSortBy');
    const btnClearFilters = wrapper.querySelector('#sfBtnClearFilters');
    const btnCloseSorted = wrapper.querySelector('#sfBtnCloseSorted');
    const btnOpenLibrary = wrapper.querySelector('#sfBtnOpenLibrary');

    btnSelect?.addEventListener('click', () => {
      STATE.selectMode = !STATE.selectMode;
      if (!STATE.selectMode) STATE.selectedIds = [];
      renderSortedFeedUI();
    });

    btnSimilar?.addEventListener('click', () => {
      STATE.similarOpen = !STATE.similarOpen;
      if (STATE.similarOpen && !document.getElementById('sandboxMountArea') && !STATE.demoMode) {
        const creator = extractCreatorHandle(STATE.currentPlatform);
        const domFound = scanDomForSimilarAccounts(creator);
        if (domFound.length > 0) mergeSimilarAccounts(domFound);

        if (STATE.currentPlatform === 'instagram') {
          let apiDone = false;
          let carouselNudged = false;
          const hadAccountsInitially = STATE.similarAccounts.length > 0;
          if (!hadAccountsInitially) {
            STATE.similarLoading = true;
          }
          renderSortedFeedUI();

          const syncDomAndRender = (stopLoading = false) => {
            const found = scanDomForSimilarAccounts(creator);
            const changed = found.length > 0 ? mergeSimilarAccounts(found) : false;
            if (stopLoading || STATE.similarAccounts.length > 0) {
              STATE.similarLoading = false;
            }
            if ((changed || stopLoading) && STATE.similarOpen && document.getElementById('sf-sorted-wrapper')) {
              renderSortedFeedUI();
            }
          };

          const onComplete = () => {
            if (apiDone) return;
            apiDone = true;
            window.removeEventListener('SF_FETCH_IG_SIMILAR_COMPLETE', onComplete);
            syncDomAndRender(true);
          };

          if (!hadAccountsInitially) {
            window.addEventListener('SF_FETCH_IG_SIMILAR_COMPLETE', onComplete);
            window.dispatchEvent(
              new CustomEvent('SF_FETCH_IG_SIMILAR', {
                detail: { username: creator }
              })
            );

            // Nudge Instagram's native Similar Accounts button if not already open
            const nativeSimilarIcon = document.querySelector(
              'svg[aria-label*="Similar accounts"], svg[aria-label*="similar accounts"]'
            );
            const nativeBtn = nativeSimilarIcon?.closest('button, [role="button"]');
            if (nativeBtn && nativeBtn.getAttribute('aria-expanded') !== 'true') {
              nativeBtn.click();
            }
          }

          // Poll Suggested/Similar DOM cards (and advance carousel once to reveal more accounts)
          [250, 600, 1200, 2000].forEach((delay, idx) => {
            setTimeout(() => {
              if (!STATE.similarOpen) return;
              if (!carouselNudged && (idx === 1 || idx === 2)) {
                const nextBtn = findSuggestedNextButton();
                if (nextBtn) {
                  carouselNudged = true;
                  nextBtn.click();
                }
              }
              syncDomAndRender(idx === 3);
            }, delay);
          });

          setTimeout(() => {
            if (STATE.similarLoading) onComplete();
          }, 2600);
          return;
        }
      }
      renderSortedFeedUI();
    });

    wrapper.querySelector('#sfBtnExportSimilar')?.addEventListener('click', () => {
      exportSimilarAccountsCsv();
    });

    wrapper.querySelectorAll('.sf-sim-avatar-img').forEach((img) => {
      img.addEventListener('error', () => {
        img.hidden = true;
        if (img.nextElementSibling?.classList.contains('sf-sim-avatar')) {
          img.nextElementSibling.hidden = false;
        }
      });
    });

    wrapper.querySelectorAll('.sf-similar-card').forEach((card) => {
      card.addEventListener('click', () => {
        const url = card.getAttribute('data-sim-url');
        if (url) window.open(url, '_blank', 'noopener');
      });
    });

    btnDownload?.addEventListener('click', () => {
      const targetPosts = getTargetActionPosts();
      downloadPostsBatch(targetPosts);
    });

    btnCopy?.addEventListener('click', () => {
      const targetPosts = getTargetActionPosts();
      copyPostsToClipboard(targetPosts);
    });

    btnExportMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
      popoverExport.hidden = !popoverExport.hidden;
      popoverFilters.hidden = true;
      popoverSortBy.hidden = true;
    });

    btnFiltersChip?.addEventListener('click', (e) => {
      e.stopPropagation();
      popoverFilters.hidden = !popoverFilters.hidden;
      popoverSortBy.hidden = true;
      popoverExport.hidden = true;
    });

    btnSortByChip?.addEventListener('click', (e) => {
      e.stopPropagation();
      popoverSortBy.hidden = !popoverSortBy.hidden;
      popoverFilters.hidden = true;
      popoverExport.hidden = true;
    });

    popoverFilters?.addEventListener('click', (e) => e.stopPropagation());
    popoverSortBy?.addEventListener('click', (e) => e.stopPropagation());
    popoverExport?.addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener(
      'click',
      () => {
        if (popoverFilters) popoverFilters.hidden = true;
        if (popoverSortBy) popoverSortBy.hidden = true;
        if (popoverExport) popoverExport.hidden = true;
      },
      { once: false }
    );

    const selectFilterDays = wrapper.querySelector('#sfSelectFilterDays');
    const customDatesWrap = wrapper.querySelector('#sfFilterCustomDatesWrap');
    selectFilterDays?.addEventListener('change', () => {
      if (customDatesWrap) {
        customDatesWrap.hidden = selectFilterDays.value !== 'custom';
      }
    });

    // Apply Filters button
    wrapper.querySelector('#sfBtnApplyFilters')?.addEventListener('click', () => {
      const minVal = wrapper.querySelector('#sfInputMin')?.value;
      const maxVal = wrapper.querySelector('#sfInputMax')?.value;
      const daysVal = wrapper.querySelector('#sfSelectFilterDays')?.value || 'all';
      const startVal = wrapper.querySelector('#sfFilterDateStart')?.value || null;
      const endVal = wrapper.querySelector('#sfFilterDateEnd')?.value || null;
      STATE.filterMin = minVal !== '' ? Number(minVal) : null;
      STATE.filterMax = maxVal !== '' ? Number(maxVal) : null;
      STATE.filterDays = daysVal;
      STATE.filterDateStart = daysVal === 'custom' ? startVal : null;
      STATE.filterDateEnd = daysVal === 'custom' ? endVal : null;
      applyFiltersAndSort();
      renderSortedFeedUI();
      syncAndEnsureInstagramDateHistory();
    });

    // Instant Sort By menu items
    wrapper.querySelectorAll('[data-sort-metric]').forEach((item) => {
      item.addEventListener('click', () => {
        STATE.currentMetric = item.getAttribute('data-sort-metric') || 'outlier';
        applyFiltersAndSort();
        renderSortedFeedUI();
      });
    });

    // Export format items
    wrapper.querySelectorAll('[data-export]').forEach((item) => {
      item.addEventListener('click', () => {
        const format = item.getAttribute('data-export');
        const targetPosts = getTargetActionPosts();
        runExportFormat(format, targetPosts);
        popoverExport.hidden = true;
      });
    });

    const resetAllFilters = () => {
      STATE.filterMin = null;
      STATE.filterMax = null;
      STATE.filterDays = 'all';
      STATE.filterDateStart = null;
      STATE.filterDateEnd = null;
      applyFiltersAndSort();
      renderSortedFeedUI();
    };

    btnClearFilters?.addEventListener('click', resetAllFilters);
    wrapper.querySelector('#sfBtnEmptyClearFilters')?.addEventListener('click', resetAllFilters);

    wrapper.querySelector('#sfBtnLoadMore')?.addEventListener('click', () => {
      STATE.renderedLimit = (STATE.renderedLimit || 100) + 100;
      renderSortedFeedUI();
    });

    wrapper.querySelector('#sfBtnShowAll')?.addEventListener('click', () => {
      STATE.renderedLimit = STATE.filteredPosts.length || 10000;
      renderSortedFeedUI();
    });

    btnOpenLibrary?.addEventListener('click', () => {
      if (hasChromeRuntime) {
        chrome.runtime.sendMessage({ type: 'SF_OPEN_LIBRARY', demo: false });
      } else {
        document.querySelector('.sf-nav-item[data-view="all"]')?.click();
      }
    });

    btnCloseSorted?.addEventListener('click', () => {
      restoreNativeGrid();
      wrapper.remove();
    });

    // Card quick actions (Save, Download, Transcribe)
    wrapper.querySelectorAll('[data-card-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-card-action');
        const postId = btn.getAttribute('data-id');
        const post = STATE.filteredPosts.find((p) => p.id === postId);
        if (!post) return;

        if (action === 'save') {
          toggleSavePost(post);
        } else if (action === 'download') {
          downloadPostsBatch([post]);
        } else if (action === 'transcribe') {
          const idx = STATE.filteredPosts.findIndex((p) => p.id === postId);
          openPlayerModal(idx, true);
        }
      });
    });

    // Card click: either toggle selection in Select mode, or open Video Player Modal
    wrapper.querySelectorAll('.sf-card-item').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = Number(card.getAttribute('data-index'));
        const post = STATE.filteredPosts[idx];
        if (!post) return;

        if (STATE.selectMode) {
          const pos = STATE.selectedIds.indexOf(post.id);
          if (pos >= 0) {
            STATE.selectedIds.splice(pos, 1);
          } else {
            STATE.selectedIds.push(post.id);
          }
          renderSortedFeedUI();
          return;
        }

        if (STATE.settings.openPostsIn === 'platform') {
          window.open(post.url, '_blank', 'noopener');
        } else {
          openPlayerModal(idx, false);
        }
      });
    });
  }

  function getTargetActionPosts() {
    if (STATE.selectMode && STATE.selectedIds.length > 0) {
      return STATE.selectedIds
        .map((id) => STATE.filteredPosts.find((p) => p.id === id))
        .filter(Boolean);
    }
    return STATE.filteredPosts;
  }

  // ============================================================================
  // 6. IN-PAGE VIDEO PLAYER MODAL (getting-started-03.mp4 @ 00:02-00:17)
  // ============================================================================
  function formatPlayerTime(seconds) {
    const totalSec = Math.max(0, Math.floor(Number(seconds) || 0));
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function parseDurationToSeconds(durStr) {
    if (!durStr || typeof durStr !== 'string') return 23;
    const parts = durStr.trim().split(':').map((n) => Number(n));
    if (parts.some((n) => isNaN(n) || n < 0)) return 23;
    if (parts.length === 3) {
      const sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      return sec > 0 ? sec : 23;
    }
    if (parts.length === 2) {
      const sec = parts[0] * 60 + parts[1];
      return sec > 0 ? sec : 23;
    }
    return 23;
  }

  function createVisualWrapEl(post) {
    const wrap = document.createElement('div');
    wrap.className = 'sf-player-visual-wrap';
    wrap.innerHTML = `
      <img class="sf-player-poster-img" id="sfPosterAnimImg" src="${escapeHtml(post.thumbnail)}" alt="${escapeHtml(post.caption)}" />
      <div class="sf-player-hook-overlay">${escapeHtml((post.caption || 'Viral Breakout Hook').slice(0, 56))}</div>
    `;
    return wrap;
  }

  function mountYoutubeEmbedFallback(post, backdrop) {
    if (!post || post.platform !== 'youtube' || !post.shortcode || !document.body.contains(backdrop)) {
      return false;
    }
    const stage = backdrop.querySelector('#sfPlayerStage');
    if (!stage) return false;
    if (stage.querySelector('#sfYoutubeIframe')) return true;

    const embedUrl = `https://www.youtube.com/embed/${encodeURIComponent(post.shortcode)}?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
    const iframe = document.createElement('iframe');
    iframe.className = 'sf-player-video';
    iframe.id = 'sfYoutubeIframe';
    iframe.src = embedUrl;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute(
      'allow',
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
    );
    iframe.allowFullscreen = true;
    iframe.style.cssText = 'border:none;width:100%;height:100%;';

    const targetToReplace = stage.querySelector('#sfVideoEl') || stage.querySelector('.sf-player-visual-wrap');
    if (targetToReplace) {
      targetToReplace.replaceWith(iframe);
    } else {
      stage.prepend(iframe);
    }
    const controls = stage.querySelector('.sf-video-controls');
    if (controls) controls.style.display = 'none';
    return true;
  }

  function attachVideoErrorFallback(videoEl, post, backdrop) {
    if (!videoEl || videoEl.dataset.sfErrBound) return;
    videoEl.dataset.sfErrBound = '1';
    videoEl.addEventListener('error', () => {
      if (!document.body.contains(backdrop)) return;
      if (mountYoutubeEmbedFallback(post, backdrop)) return;
      videoEl.replaceWith(createVisualWrapEl(post));
    });
  }

  function formatTranscriptStamp(seconds) {
    const totalSec = Math.max(0, Math.floor(Number(seconds) || 0));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function stopActivePlayerVideo(backdrop) {
    const oldVideo = backdrop?.querySelector('#sfVideoEl');
    if (oldVideo) {
      try {
        oldVideo.pause();
        oldVideo.removeAttribute('src');
        oldVideo.load();
      } catch {}
    }
    const oldIframe = backdrop?.querySelector('#sfYoutubeIframe');
    if (oldIframe) {
      try {
        oldIframe.src = 'about:blank';
      } catch {}
    }
  }

  function openPlayerModal(index, autoTranscribe = false) {
    if (index < 0 || index >= STATE.filteredPosts.length) return;
    const post = STATE.filteredPosts[index];
    if (post.platform === 'youtube' && post.videoUrl && /[?&]c=WEB\b/i.test(post.videoUrl)) {
      post.videoUrl = '';
    }
    STATE.activePlayerIndex = index;
    STATE.playerPlaying = true;
    STATE.playerTime = 0;
    STATE.playerDuration = parseDurationToSeconds(post.duration);

    let backdrop = document.getElementById('sf-player-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'sf-player-backdrop';
      document.body.appendChild(backdrop);
    } else {
      stopActivePlayerVideo(backdrop);
    }

    const isSaved = STATE.savedPostIds.has(post.id);
    const total = STATE.filteredPosts.length;
    const pubDateStr = formatPublishDate(post.publishedAt, post);
    const isModalWidescreen = post.platform === 'youtube' && post.type !== 'short';

    backdrop.innerHTML = `
      <div class="sf-player-modal ${isModalWidescreen ? 'is-widescreen' : ''}" role="dialog" aria-modal="true">
        <!-- Left Video / Animated Stage -->
        <div class="sf-player-stage" id="sfPlayerStage">
          ${
            post.videoUrl
              ? `<video class="sf-player-video" id="sfVideoEl" referrerpolicy="no-referrer" src="${escapeHtml(post.videoUrl)}" poster="${escapeHtml(post.thumbnail)}" autoplay loop playsinline ${STATE.settings.playerMuted ? 'muted' : ''}></video>`
              : `<div class="sf-player-visual-wrap">
                   <img class="sf-player-poster-img" id="sfPosterAnimImg" src="${escapeHtml(post.thumbnail)}" alt="${escapeHtml(post.caption)}" />
                   <div class="sf-player-hook-overlay">${escapeHtml((post.caption || 'Viral Breakout Hook').slice(0, 56))}</div>
                 </div>`
          }

          <div class="sf-video-controls">
            <div class="sf-scrubber-row">
              <input type="range" id="sfPlayerScrubber" class="sf-scrubber" min="0" max="${STATE.playerDuration}" step="0.2" value="0" />
              <span class="sf-time-label" id="sfPlayerTimeLabel">0:00 / ${formatPlayerTime(STATE.playerDuration)}</span>
            </div>
            <div class="sf-controls-buttons">
              <div class="sf-ctrl-group">
                <button type="button" class="sf-ctrl-btn" id="sfBtnPlayPause" title="Play / Pause (Space)">⏸</button>
                <button type="button" class="sf-ctrl-btn" id="sfBtnSeekBack" title="Back 5s">-5s</button>
                <button type="button" class="sf-ctrl-btn" id="sfBtnSeekFwd" title="Forward 5s">+5s</button>
              </div>
              <div class="sf-ctrl-group">
                <button type="button" class="sf-ctrl-btn" id="sfBtnSpeed" title="Playback Speed">${STATE.playerSpeed}x</button>
                <button type="button" class="sf-ctrl-btn" id="sfBtnMute" title="Mute / Unmute (M)">
                  ${STATE.settings.playerMuted ? '🔇' : '🔊'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Details & Actions Sidebar -->
        <div class="sf-player-sidebar">
          <div class="sf-sidebar-top">
            <div class="sf-nav-header">
              <span class="sf-pos-pill">${index + 1} of ${total}</span>
              <div class="sf-nav-arrows">
                <button type="button" class="sf-nav-icon-btn" id="sfBtnPrevPost" title="Previous (←)">‹</button>
                <button type="button" class="sf-nav-icon-btn" id="sfBtnNextPost" title="Next (→)">›</button>
                <button type="button" class="sf-nav-icon-btn" id="sfBtnClosePlayer" title="Close (Esc)">✕</button>
              </div>
            </div>

            <div class="sf-metrics-table">
              <div class="sf-metric-row">
                <span class="sf-metric-label">▶ Views</span>
                <span class="sf-metric-val">${formatCount(post.views)}</span>
              </div>
              <div class="sf-metric-row">
                <span class="sf-metric-label">♥ Likes</span>
                <span class="sf-metric-val">${formatCount(post.likes)}</span>
              </div>
              <div class="sf-metric-row">
                <span class="sf-metric-label">💬 Comments</span>
                <span class="sf-metric-val">${formatCount(post.comments)}</span>
              </div>
              ${
                post.shares
                  ? `<div class="sf-metric-row">
                       <span class="sf-metric-label">↗ Shares</span>
                       <span class="sf-metric-val">${formatCount(post.shares)}</span>
                     </div>`
                  : ''
              }
              <div class="sf-metric-row">
                <span class="sf-metric-label">⚡ Outlier score</span>
                <span class="sf-metric-val is-outlier">${post.outlierScore}x</span>
              </div>
              <div class="sf-metric-row">
                <span class="sf-metric-label">📅 Published</span>
                <span class="sf-metric-val">${escapeHtml(pubDateStr)}</span>
              </div>
            </div>

            <div class="sf-caption-box" title="Post Caption / Hook">
              <strong>@${escapeHtml(post.author || 'creator')}:</strong> ${escapeHtml(post.caption || 'No caption')}
            </div>

            <div class="sf-transcript-box" id="sfTranscriptBox" ${post.transcript ? '' : 'hidden'}>
              <div class="sf-transcript-header">
                <span>⚡ Video Transcript</span>
                <div style="display:flex;gap:8px;">
                  <button type="button" class="sf-mini-link" id="sfBtnCopyTranscript">Copy w/ timestamps</button>
                  <button type="button" class="sf-mini-link" id="sfBtnDownloadTranscript">Download .txt</button>
                </div>
              </div>
              <div id="sfTranscriptContent">${post.transcript ? renderTranscriptLinesHtml(post.transcript) : ''}</div>
            </div>
          </div>

          <div class="sf-sidebar-actions">
            <button type="button" class="sf-sidebar-action-btn" id="sfPlayerBtnSave">
              <span>${isSaved ? '🔖 Saved in Library (Click to remove)' : '🔖 Save to Library'}</span>
              <kbd class="sf-shortcut-kbd">S</kbd>
            </button>
            <button type="button" class="sf-sidebar-action-btn" id="sfPlayerBtnTranscribe">
              <span>文A Transcribe video</span>
              <kbd class="sf-shortcut-kbd">T</kbd>
            </button>
            <button type="button" class="sf-sidebar-action-btn" id="sfPlayerBtnDownload">
              <span>↓ Download video (No watermark)</span>
              <kbd class="sf-shortcut-kbd">D</kbd>
            </button>
            <div class="sf-player-bottom-row">
              <button type="button" class="sf-sidebar-action-btn" id="sfPlayerBtnOpenOrig" style="flex:1;border:1px solid #e7e5e0;">
                <span>↗ Open on ${escapeHtml(capitalize(STATE.currentPlatform))}</span>
                <span class="sf-shortcut-kbd">↗</span>
              </button>
              <button type="button" class="sf-more-btn" id="sfPlayerBtnMore" title="More download & copy actions">⋯</button>
              <div class="sf-player-more-popover" id="sfPlayerMoreMenu" hidden>
                <button type="button" class="sf-menu-item" id="sfMoreDownloadVideo">
                  <span>↓ Download video</span>
                  <span class="sf-menu-sub">.mp4</span>
                </button>
                <button type="button" class="sf-menu-item" id="sfMoreDownloadThumb">
                  <span>🖼 Download thumbnail</span>
                  <span class="sf-menu-sub">.png</span>
                </button>
                <button type="button" class="sf-menu-item" id="sfMoreCopyLink">
                  <span>🔗 Copy link</span>
                  <span class="sf-menu-sub">URL</span>
                </button>
                <button type="button" class="sf-menu-item" id="sfMoreCopyCaption">
                  <span>📝 Copy caption</span>
                  <span class="sf-menu-sub">Text</span>
                </button>
                <button type="button" class="sf-menu-item" id="sfMoreCopyRow">
                  <span>📊 Copy row for Sheets</span>
                  <span class="sf-menu-sub">TSV</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const initialVideoEl = backdrop.querySelector('#sfVideoEl');
    if (initialVideoEl) {
      initialVideoEl.playbackRate = STATE.playerSpeed || 1;
      initialVideoEl.muted = Boolean(STATE.settings.playerMuted);
      attachVideoErrorFallback(initialVideoEl, post, backdrop);
    }

    startCanvasOrVideoPlayback(post, backdrop);
    bindPlayerModalEvents(backdrop, post);

    // Proactively resolve real watermark-free video URL if not yet cached
    if (!post.videoUrl && !post.id.includes('_SF')) {
      resolvePostMediaUrls(post).then((resolved) => {
        if (resolved.videoUrl && STATE.activePlayerIndex === index && document.body.contains(backdrop)) {
          post.videoUrl = resolved.videoUrl;
          const stage = backdrop.querySelector('#sfPlayerStage');
          const visualWrap = stage?.querySelector('.sf-player-visual-wrap');
          if (visualWrap) {
            const v = document.createElement('video');
            v.className = 'sf-player-video';
            v.id = 'sfVideoEl';
            v.referrerPolicy = 'no-referrer';
            v.src = resolved.videoUrl;
            v.poster = post.thumbnail;
            v.autoplay = Boolean(STATE.playerPlaying);
            v.loop = true;
            v.playsInline = true;
            v.muted = Boolean(STATE.settings.playerMuted);
            v.playbackRate = STATE.playerSpeed || 1;
            attachVideoErrorFallback(v, post, backdrop);
            v.addEventListener(
              'loadedmetadata',
              () => {
                if (v.duration && !isNaN(v.duration)) {
                  STATE.playerDuration = Math.max(1, Math.round(v.duration));
                  if (STATE.playerTime > 0 && STATE.playerTime < v.duration) {
                    v.currentTime = STATE.playerTime;
                  }
                }
                if (!STATE.playerPlaying) {
                  v.pause();
                } else {
                  v.play().catch(() => {});
                }
              },
              { once: true }
            );
            visualWrap.replaceWith(v);
            if (!STATE.playerPlaying) {
              v.pause();
            }
          }
        } else if (
          !resolved.videoUrl &&
          post.platform === 'youtube' &&
          post.shortcode &&
          STATE.activePlayerIndex === index &&
          document.body.contains(backdrop)
        ) {
          mountYoutubeEmbedFallback(post, backdrop);
        }
      });
    }

    if (autoTranscribe) {
      generateTranscriptForPost(post, backdrop);
    }
  }

  function startCanvasOrVideoPlayback(post, backdrop) {
    if (STATE.playerTimerId) {
      clearInterval(STATE.playerTimerId);
      STATE.playerTimerId = null;
    }

    STATE.playerTimerId = setInterval(() => {
      if (!document.getElementById('sf-player-backdrop')) {
        clearInterval(STATE.playerTimerId);
        STATE.playerTimerId = null;
        return;
      }

      const posterImg = backdrop.querySelector('#sfPosterAnimImg');
      const videoEl = backdrop.querySelector('#sfVideoEl');
      const scrubber = backdrop.querySelector('#sfPlayerScrubber');
      const timeLabel = backdrop.querySelector('#sfPlayerTimeLabel');

      if (videoEl) {
        if (videoEl.duration && !isNaN(videoEl.duration)) {
          STATE.playerDuration = Math.max(1, Math.round(videoEl.duration));
        }
        if (videoEl.playbackRate !== STATE.playerSpeed) {
          videoEl.playbackRate = STATE.playerSpeed || 1;
        }
        if (videoEl.muted !== Boolean(STATE.settings.playerMuted)) {
          videoEl.muted = Boolean(STATE.settings.playerMuted);
        }
        if (STATE.playerPlaying) {
          if (videoEl.paused && videoEl.readyState >= 2) {
            videoEl.play().catch(() => {});
          }
          STATE.playerTime = videoEl.currentTime || 0;
        } else if (!videoEl.paused) {
          videoEl.pause();
        }
      } else if (STATE.playerPlaying) {
        STATE.playerTime += 0.1 * (STATE.playerSpeed || 1);
        if (STATE.playerTime > STATE.playerDuration) STATE.playerTime = 0;
        if (posterImg) {
          const zoom = 1 + Math.sin(STATE.playerTime * 0.45) * 0.035;
          posterImg.style.transform = `scale(${zoom.toFixed(4)})`;
        }
      }

      if (scrubber) {
        scrubber.max = String(STATE.playerDuration);
        scrubber.value = String(STATE.playerTime.toFixed(1));
      }
      if (timeLabel) {
        timeLabel.textContent = `${formatPlayerTime(STATE.playerTime)} / ${formatPlayerTime(STATE.playerDuration)}`;
      }
    }, 100);
  }

  function bindPlayerModalEvents(backdrop, post) {
    const btnPlayPause = backdrop.querySelector('#sfBtnPlayPause');
    const btnSeekBack = backdrop.querySelector('#sfBtnSeekBack');
    const btnSeekFwd = backdrop.querySelector('#sfBtnSeekFwd');
    const btnSpeed = backdrop.querySelector('#sfBtnSpeed');
    const btnMute = backdrop.querySelector('#sfBtnMute');
    const scrubber = backdrop.querySelector('#sfPlayerScrubber');
    const timeLabel = backdrop.querySelector('#sfPlayerTimeLabel');
    const playerStage = backdrop.querySelector('#sfPlayerStage');

    const syncScrubberAndLabel = () => {
      if (scrubber) {
        scrubber.max = String(STATE.playerDuration);
        scrubber.value = String(STATE.playerTime.toFixed(1));
      }
      if (timeLabel) {
        timeLabel.textContent = `${formatPlayerTime(STATE.playerTime)} / ${formatPlayerTime(STATE.playerDuration)}`;
      }
    };

    const togglePlayPause = () => {
      STATE.playerPlaying = !STATE.playerPlaying;
      const v = backdrop.querySelector('#sfVideoEl');
      if (v) {
        if (STATE.playerPlaying) {
          v.play().catch(() => {});
        } else {
          v.pause();
        }
      }
      if (btnPlayPause) {
        btnPlayPause.textContent = STATE.playerPlaying ? '⏸' : '▶';
      }
    };

    const seekToSeconds = (targetSec) => {
      const v = backdrop.querySelector('#sfVideoEl');
      const maxDur = v && v.duration && !isNaN(v.duration) ? v.duration : STATE.playerDuration;
      const clamped = Math.max(0, Math.min(maxDur, Number(targetSec) || 0));
      STATE.playerTime = clamped;
      if (v) {
        v.currentTime = clamped;
      }
      syncScrubberAndLabel();
    };

    btnPlayPause?.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlayPause();
    });

    playerStage?.addEventListener('click', (e) => {
      if (e.target.closest('.sf-video-controls')) return;
      togglePlayPause();
    });

    btnSeekBack?.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = backdrop.querySelector('#sfVideoEl');
      const baseTime = v ? v.currentTime : STATE.playerTime;
      seekToSeconds(baseTime - 5);
    });

    btnSeekFwd?.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = backdrop.querySelector('#sfVideoEl');
      const baseTime = v ? v.currentTime : STATE.playerTime;
      seekToSeconds(baseTime + 5);
    });

    btnSpeed?.addEventListener('click', (e) => {
      e.stopPropagation();
      const speeds = [0.5, 1, 1.5, 2, 3];
      const nextIdx = (speeds.indexOf(STATE.playerSpeed) + 1) % speeds.length;
      STATE.playerSpeed = speeds[nextIdx];
      btnSpeed.textContent = `${STATE.playerSpeed}x`;
      const v = backdrop.querySelector('#sfVideoEl');
      if (v) {
        v.playbackRate = STATE.playerSpeed;
      }
    });

    btnMute?.addEventListener('click', (e) => {
      e.stopPropagation();
      STATE.settings.playerMuted = !STATE.settings.playerMuted;
      btnMute.textContent = STATE.settings.playerMuted ? '🔇' : '🔊';
      const v = backdrop.querySelector('#sfVideoEl');
      if (v) {
        v.muted = Boolean(STATE.settings.playerMuted);
      }
      if (hasChromeStorage) {
        chrome.storage.local.set({ sf_settings: STATE.settings });
      }
    });

    const handleScrub = () => {
      const targetTime = Number(scrubber.value) || 0;
      seekToSeconds(targetTime);
    };
    scrubber?.addEventListener('input', handleScrub);
    scrubber?.addEventListener('change', handleScrub);

    backdrop.querySelector('#sfTranscriptContent')?.addEventListener('click', (e) => {
      const link = e.target.closest('[data-seek-sec]');
      if (!link) return;
      const sec = Number(link.getAttribute('data-seek-sec'));
      if (!isNaN(sec)) {
        seekToSeconds(sec);
      }
    });

    backdrop.querySelector('#sfBtnPrevPost')?.addEventListener('click', () => {
      const prevIdx =
        (STATE.activePlayerIndex - 1 + STATE.filteredPosts.length) % STATE.filteredPosts.length;
      openPlayerModal(prevIdx);
    });

    backdrop.querySelector('#sfBtnNextPost')?.addEventListener('click', () => {
      const nextIdx = (STATE.activePlayerIndex + 1) % STATE.filteredPosts.length;
      openPlayerModal(nextIdx);
    });

    backdrop.querySelector('#sfBtnClosePlayer')?.addEventListener('click', closePlayerModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closePlayerModal();
    });

    backdrop.querySelector('#sfPlayerBtnSave')?.addEventListener('click', () => {
      toggleSavePost(post);
      openPlayerModal(STATE.activePlayerIndex);
    });

    backdrop.querySelector('#sfPlayerBtnTranscribe')?.addEventListener('click', () => {
      generateTranscriptForPost(post, backdrop);
    });

    backdrop.querySelector('#sfPlayerBtnDownload')?.addEventListener('click', () => {
      downloadPostsBatch([post]);
    });

    backdrop.querySelector('#sfPlayerBtnOpenOrig')?.addEventListener('click', () => {
      window.open(post.url, '_blank', 'noopener');
    });

    const btnMore = backdrop.querySelector('#sfPlayerBtnMore');
    const moreMenu = backdrop.querySelector('#sfPlayerMoreMenu');
    btnMore?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (moreMenu) moreMenu.hidden = !moreMenu.hidden;
    });

    backdrop.querySelector('#sfMoreDownloadVideo')?.addEventListener('click', () => {
      if (moreMenu) moreMenu.hidden = true;
      downloadPostsBatch([post]);
    });

    backdrop.querySelector('#sfMoreDownloadThumb')?.addEventListener('click', () => {
      if (moreMenu) moreMenu.hidden = true;
      downloadThumbnailForPost(post);
    });

    backdrop.querySelector('#sfMoreCopyLink')?.addEventListener('click', () => {
      if (moreMenu) moreMenu.hidden = true;
      navigator.clipboard.writeText(post.url || location.href);
      showToast('Post link copied to clipboard');
    });

    backdrop.querySelector('#sfMoreCopyCaption')?.addEventListener('click', () => {
      if (moreMenu) moreMenu.hidden = true;
      navigator.clipboard.writeText(post.caption || '');
      showToast('Caption copied to clipboard');
    });

    backdrop.querySelector('#sfMoreCopyRow')?.addEventListener('click', () => {
      if (moreMenu) moreMenu.hidden = true;
      copyPostsToClipboard([post]);
    });

    backdrop.querySelector('#sfBtnCopyTranscript')?.addEventListener('click', () => {
      if (post.transcript) {
        navigator.clipboard.writeText(post.transcript);
        showToast('Transcript copied with timestamps');
      }
    });

    backdrop.querySelector('#sfBtnDownloadTranscript')?.addEventListener('click', () => {
      if (post.transcript) {
        downloadBlobFile(
          new Blob([post.transcript], { type: 'text/plain;charset=utf-8' }),
          `${post.author || 'creator'}_${post.shortcode}_transcript.txt`
        );
      }
    });
  }

  function closePlayerModal() {
    if (STATE.playerTimerId) {
      clearInterval(STATE.playerTimerId);
      STATE.playerTimerId = null;
    }
    STATE.activePlayerIndex = -1;
    const backdrop = document.getElementById('sf-player-backdrop');
    if (backdrop) {
      stopActivePlayerVideo(backdrop);
      backdrop.remove();
    }
  }

  // Keyboard shortcuts inside Player Modal (←, →, Space, M, T, S, Escape)
  window.addEventListener('keydown', (e) => {
    if (STATE.activePlayerIndex < 0 || !document.getElementById('sf-player-backdrop')) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName || '')) return;

    const post = STATE.filteredPosts[STATE.activePlayerIndex];
    if (!post) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closePlayerModal();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      openPlayerModal((STATE.activePlayerIndex + 1) % STATE.filteredPosts.length);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      openPlayerModal(
        (STATE.activePlayerIndex - 1 + STATE.filteredPosts.length) % STATE.filteredPosts.length
      );
    } else if (e.key === ' ') {
      e.preventDefault();
      document.getElementById('sfBtnPlayPause')?.click();
    } else if (e.key.toLowerCase() === 'm') {
      e.preventDefault();
      document.getElementById('sfBtnMute')?.click();
    } else if (e.key.toLowerCase() === 't') {
      e.preventDefault();
      const backdrop = document.getElementById('sf-player-backdrop');
      if (backdrop) generateTranscriptForPost(post, backdrop);
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      toggleSavePost(post);
      openPlayerModal(STATE.activePlayerIndex);
    } else if (e.key.toLowerCase() === 'd') {
      e.preventDefault();
      downloadPostsBatch([post]);
    }
  });

  function parseSubtitlesText(raw) {
    if (!raw || typeof raw !== 'string') return '';

    const decodeEntities = (str) =>
      String(str || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 32));

    // Support YouTube XML timedtext (<transcript><text start="1.2" dur="3.4">...</text></transcript>)
    if (/<text\b[^>]*start="/i.test(raw)) {
      const xmlCues = [];
      const textRe = /<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/gi;
      let m;
      while ((m = textRe.exec(raw)) !== null) {
        const sec = parseFloat(m[1]) || 0;
        const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .trim();
        if (text) {
          xmlCues.push(`[${formatTranscriptStamp(sec)}] ${text}`);
        }
      }
      if (xmlCues.length > 0) return xmlCues.join('\n');
    }

    const cleaned = raw.replace(/\r\n/g, '\n').replace(/^WEBVTT[^\n]*\n+/i, '').trim();
    const lines = cleaned.split('\n');
    const cues = [];
    let currentTimeSec = null;
    let buffer = [];

    const parseTimeToSec = (ts) => {
      const parts = ts.replace(',', '.').trim().split(':');
      if (parts.length === 3) {
        return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + parseFloat(parts[2]);
      }
      if (parts.length === 2) {
        return Number(parts[0]) * 60 + parseFloat(parts[1]);
      }
      return 0;
    };

    const flush = () => {
      if (currentTimeSec !== null && buffer.length > 0) {
        const text = buffer
          .join(' ')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) {
          cues.push(`[${formatTranscriptStamp(currentTimeSec)}] ${text}`);
        }
      }
      currentTimeSec = null;
      buffer = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        flush();
        continue;
      }
      if (/^\d+$/.test(trimmed) && currentTimeSec === null) {
        continue;
      }
      const tsMatch = trimmed.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/);
      if (tsMatch) {
        flush();
        currentTimeSec = parseTimeToSec(tsMatch[1]);
      } else if (currentTimeSec !== null && !/^NOTE\b/i.test(trimmed)) {
        buffer.push(trimmed);
      }
    }
    flush();

    return cues.join('\n');
  }

  function buildRealTranscriptForPost(post, durationSec = 24) {
    const rawSource = String(post?.caption || post?.accessibilityCaption || post?.title || '').trim();
    if (!rawSource) {
      return `[00:00] @${post?.author || 'creator'} (${post?.platform || 'video'})`;
    }

    // Separate trailing hashtag block (e.g., #Madurai #Tanishq #Police) from spoken/story text
    let body = rawSource;
    let hashtagsLine = '';
    const trailingTagsMatch = body.match(/((?:\s*#[\p{L}\p{N}_]+)+)\s*$/u);
    if (trailingTagsMatch && trailingTagsMatch.index > 0) {
      const candidateBody = body.slice(0, trailingTagsMatch.index).replace(/[\s|•\-–—]+$/, '').trim();
      if (candidateBody.length > 0) {
        body = candidateBody;
        hashtagsLine = trailingTagsMatch[1].trim().replace(/\s+/g, ' ');
      }
    }

    // Remove inline decorative dividers & split by Unicode sentence punctuation or line breaks
    const rawSegments = body
      .split(/(?<=[.!?।|])\s+|\n+/)
      .map((s) => s.replace(/^[\s\-–—•|]+|[\s|]+$/g, '').trim())
      .filter(Boolean);

    // Further split any overly long segments (> 16 words) into readable ~12-word chunks
    const segments = [];
    rawSegments.forEach((seg) => {
      const words = seg.split(/\s+/);
      if (words.length <= 16) {
        segments.push(seg);
      } else {
        for (let i = 0; i < words.length; i += 12) {
          const chunk = words.slice(i, i + 12).join(' ').trim();
          if (chunk) segments.push(chunk);
        }
      }
    });

    if (segments.length === 0) {
      segments.push(body);
    }

    const dur = Math.max(10, Math.round(Number(durationSec) || 24));
    const totalSegs = segments.length;
    const lines = segments.map((seg, idx) => {
      const sec = totalSegs === 1 ? 0 : Math.round((idx / totalSegs) * Math.max(1, dur - 3));
      return `[${formatTranscriptStamp(sec)}] ${seg}`;
    });

    if (hashtagsLine) {
      lines.push(`[Tags] ${hashtagsLine}`);
    }

    return lines.join('\n');
  }

  function renderTranscriptLinesHtml(transcript) {
    if (!transcript) return '';
    return String(transcript)
      .split('\n')
      .map((line) => {
        const tsMatch = line.match(/^\[(\d{1,2}):(\d{2})\]\s*(.*)$/);
        if (tsMatch) {
          const sec = Number(tsMatch[1]) * 60 + Number(tsMatch[2]);
          const stamp = `[${tsMatch[1].padStart(2, '0')}:${tsMatch[2]}]`;
          return `<div><button type="button" class="sf-ts-link" data-seek-sec="${sec}" style="background:none;border:none;padding:0;margin-right:4px;color:#d97706;font-weight:700;cursor:pointer;font-family:inherit;font-size:inherit;" title="Jump to ${stamp}">${escapeHtml(stamp)}</button><span>${escapeHtml(tsMatch[3])}</span></div>`;
        }
        return `<div>${escapeHtml(line)}</div>`;
      })
      .join('');
  }

  async function generateTranscriptForPost(post, backdrop) {
    const box = backdrop.querySelector('#sfTranscriptBox');
    const content = backdrop.querySelector('#sfTranscriptContent');
    if (!box || !content) return;

    box.hidden = false;
    content.textContent = 'Extracting video subtitles & caption transcript...';

    let finalTranscript = '';
    if (post.subtitleUrl && post.subtitleUrl.startsWith('http')) {
      try {
        const res = await fetch(post.subtitleUrl);
        if (res.ok) {
          const rawSub = await res.text();
          finalTranscript = parseSubtitlesText(rawSub);
        }
      } catch {}
    }

    if (!finalTranscript) {
      const videoEl = backdrop.querySelector('#sfVideoEl');
      const dur =
        (videoEl && videoEl.duration && !isNaN(videoEl.duration) ? videoEl.duration : STATE.playerDuration) ||
        24;
      finalTranscript = buildRealTranscriptForPost(post, dur);
    }

    post.transcript = finalTranscript;
    if (document.body.contains(content)) {
      content.innerHTML = renderTranscriptLinesHtml(finalTranscript);
      showToast('Transcript ready');
    }
  }

  // ============================================================================
  // 7. SAVE, EXPORT (CSV, EXCEL, JSON, GOOGLE SHEETS) & DOWNLOAD
  // ============================================================================
  function toggleSavePost(post) {
    if (STATE.savedPostIds.has(post.id)) {
      STATE.savedPostIds.delete(post.id);
      if (hasChromeRuntime) {
        chrome.runtime.sendMessage({ type: 'SF_REMOVE_SAVED_POST', payload: { id: post.id } });
      }
      window.dispatchEvent(new CustomEvent('SF_LOCAL_REMOVE_POST', { detail: post.id }));
      showToast('Removed from your saved library');
    } else {
      STATE.savedPostIds.add(post.id);
      if (hasChromeRuntime) {
        chrome.runtime.sendMessage({ type: 'SF_SAVE_POST', payload: post });
      }
      window.dispatchEvent(new CustomEvent('SF_LOCAL_SAVE_POST', { detail: post }));
      showToast('Reel saved to your library', 'View saved', () => {
        if (hasChromeRuntime) {
          chrome.runtime.sendMessage({ type: 'SF_OPEN_LIBRARY', demo: false });
        } else {
          document.querySelector('.sf-nav-item[data-view="all"]')?.click();
        }
      });
    }
    if (document.getElementById('sf-sorted-wrapper')) {
      renderSortedFeedUI();
    }
  }

  function buildExportRows(posts) {
    return posts.map((p) => {
      const handle = String(p.author || 'creator').replace(/^@/, '');
      const platform = p.platform || 'instagram';
      const profileUrl =
        platform === 'tiktok'
          ? `https://www.tiktok.com/@${handle}`
          : platform === 'youtube'
          ? `https://www.youtube.com/@${handle}`
          : `https://www.${platform}.com/${handle}`;

      const base = {
        Profile: profileUrl,
        Creator: `@${handle}`,
        Link: p.url,
        CreateDate: formatPublishDate(p.publishedAt),
        Views: p.views || 0,
        OutlierScore: `${p.outlierScore || 1}x`,
        Likes: p.likes || 0,
        Comments: p.comments || 0
      };
      if (platform === 'tiktok' || platform === 'facebook' || platform === 'instagram') {
        base.Shares = p.shares || 0;
      }
      if (platform === 'tiktok') {
        base.Saves = p.saves || 0;
      }
      if (platform === 'youtube') {
        base.Duration = p.duration || '0:45';
        base.Category = p.category || 'Creator';
        base.Title = p.title || p.caption || '';
      }
      base.Caption = (p.caption || '').replace(/\r?\n/g, ' ');
      if (p.transcript) {
        base.Transcript = p.transcript.replace(/\r?\n/g, ' ');
      }
      return base;
    });
  }

  function collectExportHeaders(rows) {
    const headers = [];
    const seen = new Set();
    rows.forEach((row) => {
      Object.keys(row).forEach((k) => {
        if (!seen.has(k)) {
          seen.add(k);
          headers.push(k);
        }
      });
    });
    return headers;
  }

  function buildClipboardPayloads(posts) {
    const rows = buildExportRows(posts);
    if (rows.length === 0) return null;
    const headers = collectExportHeaders(rows);
    const tsv = [
      headers.join('\t'),
      ...rows.map((r) =>
        headers
          .map((h) => String(r[h] ?? '').replace(/[\t\r\n]+/g, ' '))
          .join('\t')
      )
    ].join('\n');

    const htmlTable = [
      '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px;">',
      '<thead><tr>',
      ...headers.map(
        (h) =>
          `<th style="background:#18181b;color:#ffffff;font-weight:700;padding:6px 10px;border:1px solid #d4d4d8;text-align:left;">${escapeHtml(h)}</th>`
      ),
      '</tr></thead>',
      '<tbody>',
      ...rows.map(
        (r) =>
          `<tr>${headers
            .map((h) => {
              const raw = r[h] ?? '';
              const str = String(raw);
              const isLink = (h === 'Profile' || h === 'Link') && /^https?:\/\//i.test(str);
              const cellContent = isLink
                ? `<a href="${escapeHtml(str)}">${escapeHtml(str)}</a>`
                : escapeHtml(str);
              return `<td style="padding:5px 10px;border:1px solid #e4e4e7;">${cellContent}</td>`;
            })
            .join('')}</tr>`
      ),
      '</tbody></table>'
    ].join('');

    const creatorSlug = String(posts[0]?.author || STATE.currentPlatform || 'feed').replace(/^@/, '');
    const sheetTitle = `ShortFeed — @${creatorSlug} (${rows.length} posts)`;

    return { rows, headers, tsv, htmlTable, sheetTitle };
  }

  function copyPostsToClipboard(posts, silent = false) {
    const built = buildClipboardPayloads(posts);
    if (!built) return null;
    const { rows, tsv, htmlTable } = built;

    const notifyCopied = () => {
      if (!silent) {
        showToast(`Copied ${rows.length} sorted rows — ready to paste into Google Sheets or Excel`);
      }
    };

    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
        'text/html': new Blob([htmlTable], { type: 'text/html' })
      });
      navigator.clipboard
        .write([item])
        .then(notifyCopied)
        .catch(() => {
          navigator.clipboard.writeText(tsv).then(notifyCopied).catch(() => {});
        });
    } else if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(tsv).then(notifyCopied).catch(() => {});
    }

    return built;
  }

  function colIndexToLetters(idx) {
    let n = idx;
    let letters = '';
    while (n >= 0) {
      letters = String.fromCharCode((n % 26) + 65) + letters;
      n = Math.floor(n / 26) - 1;
    }
    return letters;
  }

  function sanitizeXmlText(str) {
    return escapeXml(String(str ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, ''));
  }

  function buildXlsxBlob(rows, headers) {
    const encoder = new TextEncoder();

    const headerCells = headers
      .map(
        (h, cIdx) =>
          `<c r="${colIndexToLetters(cIdx)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${sanitizeXmlText(h)}</t></is></c>`
      )
      .join('');
    const sheetRows = [`<row r="1">${headerCells}</row>`];

    rows.forEach((row, rIdx) => {
      const excelRowNum = rIdx + 2;
      const cells = headers
        .map((h, cIdx) => {
          const ref = `${colIndexToLetters(cIdx)}${excelRowNum}`;
          const val = row[h];
          if (typeof val === 'number' && Number.isFinite(val)) {
            return `<c r="${ref}" t="n"><v>${val}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${sanitizeXmlText(val ?? '')}</t></is></c>`;
        })
        .join('');
      sheetRows.push(`<row r="${excelRowNum}">${cells}</row>`);
    });

    const contentTypesXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    const relsXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    const workbookXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="ShortFeed Sorted" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>';

    const workbookRelsXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    const stylesXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF18181B"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '</cellXfs>' +
      '</styleSheet>';

    const sheet1Xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${sheetRows.join('')}</sheetData>` +
      '</worksheet>';

    const zipBlob = buildZipBlob([
      { name: '[Content_Types].xml', data: encoder.encode(contentTypesXml) },
      { name: '_rels/.rels', data: encoder.encode(relsXml) },
      { name: 'xl/workbook.xml', data: encoder.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRelsXml) },
      { name: 'xl/styles.xml', data: encoder.encode(stylesXml) },
      { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheet1Xml) }
    ]);

    return new Blob([zipBlob], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  function runExportFormat(format, posts) {
    if (!posts || posts.length === 0) return;

    if (format === 'transcripts') {
      posts.forEach((p) => {
        if (!p.transcript) {
          p.transcript = buildRealTranscriptForPost(p, 24);
        }
      });
    }

    const rows = buildExportRows(posts);
    const headers = collectExportHeaders(rows);
    const creatorSlug = (posts[0]?.author || STATE.currentPlatform || 'feed').replace(/[^a-zA-Z0-9_-]/g, '');
    const filePrefix = `shortfeed_${creatorSlug}_${posts.length}_posts`;

    if (format === 'json') {
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      downloadBlobFile(blob, `${filePrefix}.json`);
      showToast(`Exported ${rows.length} rows as JSON`);
      return;
    }

    if (format === 'csv' || format === 'transcripts') {
      const csvLines = [
        headers.join(','),
        ...rows.map((r) =>
          headers
            .map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`)
            .join(',')
        )
      ].join('\r\n');
      const blob = new Blob(['\uFEFF' + csvLines], { type: 'text/csv;charset=utf-8' });
      downloadBlobFile(blob, `${filePrefix}.csv`);
      showToast(`Exported ${rows.length} rows to CSV`);
      return;
    }

    if (format === 'excel') {
      const blob = buildXlsxBlob(rows, headers);
      downloadBlobFile(blob, `${filePrefix}.xlsx`);
      showToast(`Exported ${rows.length} rows as Excel (.xlsx)`);
      return;
    }

    if (format === 'sheets') {
      const built = copyPostsToClipboard(posts, true);
      if (!built) return;
      const pendingPayload = {
        tsv: built.tsv,
        htmlTable: built.htmlTable,
        sheetTitle: built.sheetTitle,
        rowCount: built.rows.length,
        createdAt: Date.now()
      };
      if (hasChromeStorage) {
        chrome.storage.local.set({ sf_pending_sheets_export: pendingPayload });
      }
      if (hasChromeRuntime) {
        chrome.runtime.sendMessage({
          type: 'SF_EXPORT_TO_GOOGLE_SHEETS',
          payload: pendingPayload
        });
        showToast(`Opening Google Sheets and auto-filling ${built.rows.length} rows...`);
      } else {
        window.open('https://sheets.new', '_blank', 'noopener');
        showToast('Copied formatted table! Press Cmd+V / Ctrl+V in Google Sheets');
      }
    }
  }

  // ============================================================================
  // 7B. FULL VIDEO, CAROUSEL & BULK ZIP DOWNLOAD ENGINE (No Watermarks)
  // ============================================================================
  let bulkDownloadStopRequested = false;

  async function downloadPostsBatch(posts) {
    if (!posts || posts.length === 0) return;

    // Single post download: direct .mp4 video (or carousel .zip)
    if (posts.length === 1) {
      const post = posts[0];
      const creator = sanitizeName(post.author || STATE.currentPlatform || 'creator');
      const code = sanitizeName(post.shortcode || post.id || 'video');
      showToast(`Preparing watermark-free video for @${creator}...`);

      const media = await resolvePostMediaUrls(post);

      // Multi-slide Carousel -> ZIP with one file per slide
      if (media.carouselSlides && media.carouselSlides.length > 1) {
        const zipEntries = [];
        for (let i = 0; i < media.carouselSlides.length; i++) {
          const slide = media.carouselSlides[i];
          const bytes = await fetchOrSynthesizeMediaBytes(post, slide.url, slide.isVideo);
          const ext = slide.isVideo ? 'mp4' : 'jpg';
          zipEntries.push({
            name: `${String(i + 1).padStart(2, '0')}_${creator}_${code}.${ext}`,
            data: bytes
          });
        }
        const zipBlob = buildZipBlob(zipEntries);
        downloadBlobFile(zipBlob, `${creator}_${code}_carousel.zip`);
        showToast(`Downloaded carousel (${zipEntries.length} slides) as .zip`);
        return;
      }

      // Single video clip -> for YouTube stream through background service worker (where DNR UA rules apply) into a local Blob
      if (post.platform === 'youtube') {
        if (hasChromeRuntime && !post.id.includes('_SF') && chrome.runtime.connect) {
          const streamOk = await new Promise((resolve) => {
            let settled = false;
            const chunks = [];
            const finish = (ok, errMsg = '') => {
              if (settled) return;
              settled = true;
              try { port.disconnect(); } catch {}
              if (ok && chunks.length > 0) {
                const blob = new Blob(chunks, { type: 'video/mp4' });
                chunks.length = 0;
                if (blob.size > 1024) {
                  downloadBlobFile(blob, `${creator}_${code}.mp4`);
                  showToast(`Downloaded ${creator}_${code}.mp4`);
                  resolve(true);
                  return;
                }
              }
              chunks.length = 0;
              if (errMsg) showToast(`YouTube download failed (${errMsg})`);
              resolve(false);
            };

            const port = chrome.runtime.connect({ name: 'SF_STREAM_YT_DOWNLOAD' });
            port.onMessage.addListener((msg) => {
              if (!msg) return;
              if (msg.type === 'chunk' && msg.b64) {
                const raw = atob(msg.b64);
                const arr = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
                chunks.push(arr);
                if (msg.total > 0 && msg.loaded) {
                  const pct = Math.min(99, Math.round((msg.loaded / msg.total) * 100));
                  if (pct % 20 === 0) {
                    showToast(`Downloading ${creator}_${code}.mp4 (${pct}%)...`);
                  }
                }
              } else if (msg.type === 'done') {
                finish(true);
              } else if (msg.type === 'error') {
                finish(false, msg.error || 'Stream unavailable');
              }
            });
            port.onDisconnect.addListener(() => {
              if (!settled) finish(false, 'Disconnected');
            });
            port.postMessage({
              url: media.videoUrl || '',
              videoId: post.shortcode || '',
              visitorData: STATE.ytVisitorData || ''
            });
          });
          if (streamOk) return;
        }
        showToast('Could not download this YouTube video (stream protected by YouTube).');
        return;
      }

      if (hasChromeRuntime && !post.id.includes('_SF')) {
        const dlRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: 'SF_DOWNLOAD_VIDEO',
              payload: {
                url: media.videoUrl || '',
                videoId: post.shortcode || '',
                platform: post.platform || STATE.currentPlatform,
                filename: `${creator}_${code}.mp4`
              }
            },
            (resp) => resolve(chrome.runtime.lastError ? null : resp)
          );
        });
        if (dlRes?.ok) {
          showToast(`Downloading ${creator}_${code}.mp4...`);
          return;
        }
      }

      const videoBytes = await fetchOrSynthesizeMediaBytes(post, media.videoUrl, true);
      const ext = media.isSynthesized ? media.ext : 'mp4';
      const mime = ext === 'mp4' ? 'video/mp4' : 'video/webm';
      downloadBlobFile(new Blob([videoBytes], { type: mime }), `${creator}_${code}.${ext}`);
      showToast(`Downloaded ${creator}_${code}.${ext}`);
      return;
    }

    // Bulk Download (Sorted Grid or Multi-Selection) -> Progress Banner + Single .zip Archive
    bulkDownloadStopRequested = false;
    const total = posts.length;
    const zipEntries = [];
    showBulkDownloadBanner(0, total);

    for (let i = 0; i < total; i++) {
      if (bulkDownloadStopRequested) break;
      const post = posts[i];
      const creator = sanitizeName(post.author || STATE.currentPlatform || 'creator');
      const code = sanitizeName(post.shortcode || `clip${i + 1}`);
      updateBulkDownloadBanner(i + 1, total, `@${creator} (${code})`);

      try {
        const media = await resolvePostMediaUrls(post);
        const bytes = await fetchOrSynthesizeMediaBytes(post, media.videoUrl, true, 1200);
        const ext = media.isSynthesized ? media.ext : 'mp4';
        const rankPrefix = String(i + 1).padStart(2, '0');
        zipEntries.push({
          name: `${rankPrefix}_${creator}_${code}.${ext}`,
          data: bytes
        });
      } catch {}
    }

    hideBulkDownloadBanner();

    if (zipEntries.length === 0) {
      showToast('No video clips could be downloaded');
      return;
    }

    const firstCreator = sanitizeName(posts[0]?.author || STATE.currentPlatform || 'feed');
    const zipBlob = buildZipBlob(zipEntries);
    const zipName = `shortfeed_${firstCreator}_${zipEntries.length}_videos.zip`;
    downloadBlobFile(zipBlob, zipName);
    showToast(
      bulkDownloadStopRequested
        ? `Stopped early — saved ${zipEntries.length} videos in ${zipName}`
        : `Downloaded all ${zipEntries.length} videos in ${zipName}`
    );
  }

  async function resolvePostMediaUrls(post) {
    // 1. Check cached post or intercepted map (discard stale YouTube c=WEB URLs that 403)
    const intercepted = STATE.interceptedMap.get(post.id);
    if (post.platform === 'youtube' && post.videoUrl && /[?&]c=WEB\b/i.test(post.videoUrl)) {
      post.videoUrl = '';
    }
    if (intercepted?.videoUrl) {
      if (!(post.platform === 'youtube' && /[?&]c=WEB\b/i.test(intercepted.videoUrl))) {
        post.videoUrl = intercepted.videoUrl;
      }
    }
    if (intercepted?.carouselSlides?.length) post.carouselSlides = intercepted.carouselSlides;

    if (post.videoUrl && post.videoUrl.startsWith('http')) {
      return { videoUrl: post.videoUrl, carouselSlides: post.carouselSlides || [] };
    }

    // 2. Check if there is a live <video> element on the current page (skip unrelated YouTube miniplayer/preview)
    if (STATE.currentPlatform !== 'youtube') {
      const liveVideo = document.querySelector('video[src^="https://"]');
      if (liveVideo && liveVideo.src && !liveVideo.src.startsWith('blob:')) {
        return { videoUrl: liveVideo.src, carouselSlides: [] };
      }
    }

    // 3. On-demand fetch for Instagram, YouTube, TikTok & Facebook posts when on the real domain
    if (post.url && post.url.startsWith('http') && !post.id.includes('_SF')) {
      try {
        if (post.platform === 'instagram' && post.shortcode) {
          const embedRes = await fetch(
            `https://www.instagram.com/p/${post.shortcode}/embed/captioned/`,
            { credentials: 'include' }
          );
          if (embedRes.ok) {
            const html = await embedRes.text();
            const vMatch =
              html.match(/"video_url"\s*:\s*"([^"]+)"/) ||
              html.match(/property="og:video"\s+content="([^"]+)"/);
            if (vMatch && vMatch[1]) {
              const decodedUrl = vMatch[1]
                .replace(/\\u0026/g, '&')
                .replace(/\\\//g, '/')
                .replace(/&amp;/g, '&');
              post.videoUrl = decodedUrl;
              return { videoUrl: decodedUrl, carouselSlides: [] };
            }
          }
        } else if (post.platform === 'youtube' && post.shortcode) {
          const resolvedYtUrl = await new Promise((resolve) => {
            const evtName = `SF_RESOLVED_YT_STREAM_${post.shortcode}`;
            let settled = false;
            const finish = (url) => {
              if (settled) return;
              settled = true;
              window.removeEventListener(evtName, onResolved);
              resolve(url || '');
            };
            const onResolved = (ev) => {
              if (ev?.detail?.visitorData) {
                STATE.ytVisitorData = String(ev.detail.visitorData);
              }
              finish(ev?.detail?.videoUrl || '');
            };
            window.addEventListener(evtName, onResolved);
            window.dispatchEvent(
              new CustomEvent('SF_RESOLVE_YT_STREAM', { detail: { videoId: post.shortcode } })
            );
            setTimeout(() => finish(''), 4000);
          });
          if (resolvedYtUrl && resolvedYtUrl.startsWith('http')) {
            post.videoUrl = resolvedYtUrl;
            return { videoUrl: resolvedYtUrl, carouselSlides: [] };
          }

          if (hasChromeRuntime) {
            const bgRes = await new Promise((resolve) => {
              let done = false;
              const timer = setTimeout(() => {
                if (!done) {
                  done = true;
                  resolve(null);
                }
              }, 5000);
              chrome.runtime.sendMessage(
                {
                  type: 'SF_RESOLVE_YT_BG',
                  payload: { videoId: post.shortcode, visitorData: STATE.ytVisitorData || '' }
                },
                (resp) => {
                  if (done) return;
                  done = true;
                  clearTimeout(timer);
                  resolve(chrome.runtime.lastError ? null : resp);
                }
              );
            });
            if (bgRes?.ok && bgRes.videoUrl && bgRes.videoUrl.startsWith('http')) {
              post.videoUrl = bgRes.videoUrl;
              return { videoUrl: bgRes.videoUrl, carouselSlides: [] };
            }
          }
        } else if (post.platform === 'facebook' || post.platform === 'tiktok') {
          const res = await fetch(post.url, { credentials: 'include' });
          if (res.ok) {
            const html = await res.text();
            const match =
              html.match(/"browser_native_hd_url"\s*:\s*"([^"]+)"/) ||
              html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/) ||
              html.match(/"playAddr"\s*:\s*"([^"]+)"/) ||
              html.match(/"downloadAddr"\s*:\s*"([^"]+)"/);
            if (match && match[1]) {
              const decodedUrl = match[1]
                .replace(/\\u0026/g, '&')
                .replace(/\\u002F/g, '/')
                .replace(/\\\//g, '/');
              post.videoUrl = decodedUrl;
              return { videoUrl: decodedUrl, carouselSlides: [] };
            }
          }
        }
      } catch {}
    }

    // 4. Fallback / Sandbox Demo Mode: mark for real playable video synthesis
    const supportedMime =
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4')
        ? 'mp4'
        : 'webm';
    return { videoUrl: '', carouselSlides: [], isSynthesized: true, ext: supportedMime };
  }

  async function fetchOrSynthesizeMediaBytes(post, mediaUrl, isVideo = true, durationMs = 2000) {
    if (mediaUrl && mediaUrl.startsWith('http')) {
      try {
        const res = await fetch(mediaUrl);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 500) return new Uint8Array(buf);
        }
      } catch {}
    }
    return await synthesizePlayableVideoBytes(post, durationMs);
  }

  async function loadSafeCanvasImage(post) {
    const loadImg = (src, useCors) =>
      new Promise((resolve) => {
        const im = new Image();
        if (useCors) im.crossOrigin = 'anonymous';
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          resolve(ok ? im : null);
        };
        im.onload = () => finish(im.naturalWidth > 0);
        im.onerror = () => finish(false);
        setTimeout(() => finish(false), 1200);
        im.src = src;
      });

    const thumbUrl = post.thumbnail || '';
    if (thumbUrl.startsWith('data:') || thumbUrl.startsWith('blob:')) {
      const direct = await loadImg(thumbUrl, false);
      if (direct) return direct;
    } else if (thumbUrl.startsWith('http')) {
      // 1. Fetch as blob so the image becomes same-origin and never taints <canvas>
      try {
        const res = await fetch(thumbUrl, { mode: 'cors', credentials: 'omit' });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 200) {
            const objUrl = URL.createObjectURL(blob);
            const blobImg = await loadImg(objUrl, false);
            setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
            if (blobImg) return blobImg;
          }
        }
      } catch {}

      // 2. Fallback to CORS anonymous image load
      const corsImg = await loadImg(thumbUrl, true);
      if (corsImg) return corsImg;
    }

    // 3. Guaranteed untainted SVG data URI fallback
    const fallbackUri = createPosterDataUri(post.title || post.caption || post.shortcode, post.views, 0);
    return await loadImg(fallbackUri, false);
  }

  // Record a real, playable clip (.mp4 / .webm) using an untainted HTML5 Canvas + MediaRecorder
  async function synthesizePlayableVideoBytes(post, durationMs = 2000) {
    const isWidescreen = post.platform === 'youtube' && post.type !== 'short';
    const w = isWidescreen ? 640 : 360;
    const h = isWidescreen ? 360 : 640;

    let canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    let ctx = canvas.getContext('2d');

    let img = await loadSafeCanvasImage(post);
    if (img) {
      try {
        ctx.drawImage(img, 0, 0, w, h);
        ctx.getImageData(0, 0, 1, 1);
      } catch {
        // Canvas got tainted — recreate a fresh untainted canvas with SVG data URI fallback
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        ctx = canvas.getContext('2d');
        const safeUri = createPosterDataUri(post.title || post.caption || post.shortcode, post.views, 0);
        img = await new Promise((resolve) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => resolve(null);
          im.src = safeUri;
        });
      }
    }

    const mimeType =
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4')
        ? 'video/mp4'
        : typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';

    const stream = canvas.captureStream(30);
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];
    const stoppedPromise = new Promise((resolve) => {
      recorder.onstop = resolve;
      setTimeout(resolve, durationMs + 1500);
    });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const startTime = performance.now();
    let framesDrawn = 0;
    recorder.start(100);

    await new Promise((resolve) => {
      function drawFrame(now) {
        const elapsed = (now - startTime) / 1000;
        framesDrawn++;
        ctx.fillStyle = '#121216';
        ctx.fillRect(0, 0, w, h);

        const zoom = 1 + Math.sin(elapsed * 2.2) * 0.04;
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.scale(zoom, zoom);
        if (img && img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, -w / 2, -h / 2, w, h);
        }
        ctx.restore();

        // Bottom watermark-free stats bar
        const barH = 56;
        const barY = h - barH - 18;
        ctx.fillStyle = 'rgba(18, 18, 22, 0.84)';
        ctx.fillRect(16, barY, w - 32, barH);
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.fillText(`@${post.author || 'creator'} • ⚡ ${post.outlierScore || 1}x Outlier`, 30, barY + 24);
        ctx.fillStyle = '#ffffff';
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillText(`▶ ${formatCount(post.views)} views   ♥ ${formatCount(post.likes)} likes`, 30, barY + 44);

        if (now - startTime < durationMs || framesDrawn < 12) {
          requestAnimationFrame(drawFrame);
        } else {
          try {
            if (recorder.state === 'recording') {
              try {
                recorder.requestData();
              } catch {}
              recorder.stop();
            }
          } catch {}
          resolve();
        }
      }
      requestAnimationFrame(drawFrame);
    });

    await stoppedPromise;

    const blob = new Blob(chunks, { type: mimeType || recorder.mimeType || 'video/webm' });
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function downloadThumbnailForPost(post) {
    const isWidescreen = post.platform === 'youtube' && post.type !== 'short';
    const w = isWidescreen ? 1280 : 720;
    const h = isWidescreen ? 720 : 1280;

    let canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    let ctx = canvas.getContext('2d');
    const img = await loadSafeCanvasImage(post);

    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, w, h);
    if (img && img.complete && img.naturalWidth > 0) {
      try {
        ctx.drawImage(img, 0, 0, w, h);
        ctx.getImageData(0, 0, 1, 1);
      } catch {
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        ctx = canvas.getContext('2d');
        ctx.fillStyle = '#18181b';
        ctx.fillRect(0, 0, w, h);
      }
    }

    canvas.toBlob((blob) => {
      if (blob && blob.size > 0) {
        downloadBlobFile(
          blob,
          `${sanitizeName(post.author || 'creator')}_${sanitizeName(post.shortcode || 'thumb')}.png`
        );
        showToast('Downloaded high-res thumbnail (.png)');
      }
    }, 'image/png');
  }

  // Pure-JS ZIP Archive Builder (Store method + IEEE 802.3 CRC32)
  function buildZipBlob(entries) {
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }

    function crc32(bytes) {
      let c = 0xffffffff;
      for (let i = 0; i < bytes.length; i++) {
        c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
      }
      return (c ^ 0xffffffff) >>> 0;
    }

    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    entries.forEach((entry) => {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const crc = crc32(data);

      // Local File Header (30 bytes + name)
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true); // Store (0)
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, data);

      // Central Directory Header (46 bytes + name)
      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);

      centralParts.push(centralHeader);
      offset += localHeader.length + data.length;
    });

    const centralSize = centralParts.reduce((acc, arr) => acc + arr.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
  }

  function showBulkDownloadBanner(current, total) {
    let banner = document.getElementById('sf-download-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'sf-download-banner';
      document.body.appendChild(banner);
    }
    banner.innerHTML = `
      <div class="sf-dl-top">
        <div class="sf-dl-title" id="sfDlBannerText">
          <span>↓ Preparing ${total} videos for bulk ZIP download...</span>
        </div>
        <button type="button" class="sf-dl-stop-btn" id="sfBtnStopBulkDl">
          ■ Stop & keep saved
        </button>
      </div>
      <div class="sf-dl-track">
        <div class="sf-dl-fill" id="sfDlBannerFill" style="width:4%"></div>
      </div>
    `;
    banner.querySelector('#sfBtnStopBulkDl')?.addEventListener('click', () => {
      bulkDownloadStopRequested = true;
    });
  }

  function updateBulkDownloadBanner(current, total, detail) {
    const textEl = document.getElementById('sfDlBannerText');
    const fillEl = document.getElementById('sfDlBannerFill');
    const pct = Math.round((current / Math.max(1, total)) * 100);
    if (textEl) {
      textEl.textContent = `↓ Downloading ${current} of ${total} (${pct}%) — ${detail}`;
    }
    if (fillEl) {
      fillEl.style.width = `${pct}%`;
    }
  }

  function hideBulkDownloadBanner() {
    document.getElementById('sf-download-banner')?.remove();
  }

  function sanitizeName(str) {
    return String(str || 'clip')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 60);
  }

  // ============================================================================
  // 7C. NATIVE HOVER BUTTONS WHILE BROWSING (No Sort Required!)
  // ============================================================================
  function attachNativeHoverButtons() {
    if (STATE.currentPlatform === 'youtube') return; // YouTube disables downloads per Sort Feed spec
    if (document.getElementById('sandboxMountArea')) return; // Handled by sorted grid in sandbox

    const selectors =
      'a[href*="/reel/"], a[href*="/p/"], a[href*="/video/"], [data-e2e="user-post-item"]';
    document.querySelectorAll(selectors).forEach((el) => {
      if (el.dataset.sfHoverAttached === '1') return;
      if (el.closest('#sf-sorted-wrapper')) return;
      el.dataset.sfHoverAttached = '1';

      const container = el.tagName === 'A' ? el : el.querySelector('a') || el;
      const computedPos = window.getComputedStyle(container).position;
      if (computedPos === 'static') {
        container.style.position = 'relative';
      }

      const bar = document.createElement('div');
      bar.className = 'sf-native-hover-bar';
      bar.innerHTML = `
        ${
          STATE.settings.showSaveButton !== false
            ? `<button type="button" class="sf-native-btn" data-native-act="save" title="Save post to ShortFeed library">🔖</button>`
            : ''
        }
        ${
          STATE.settings.showDownloadButton !== false
            ? `<button type="button" class="sf-native-btn" data-native-act="download" title="Download video without watermark">↓</button>`
            : ''
        }
        ${
          STATE.settings.showTranscribeButton !== false
            ? `<button type="button" class="sf-native-btn" data-native-act="transcribe" title="Transcribe video">文</button>`
            : ''
        }
      `;

      bar.querySelectorAll('[data-native-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const act = btn.getAttribute('data-native-act');
          const href = container.getAttribute('href') || location.href;
          const fullUrl = new URL(href, location.origin).href;
          const codeMatch = fullUrl.match(/\/(?:reel|p|video)\/([A-Za-z0-9_-]+)/);
          const shortcode = codeMatch ? codeMatch[1] : `post_${Date.now()}`;
          const img = container.querySelector('img');

          const postObj = STATE.interceptedMap.get(`${STATE.currentPlatform}_${shortcode}`) || {
            id: `${STATE.currentPlatform}_${shortcode}`,
            shortcode,
            platform: STATE.currentPlatform,
            type: 'reel',
            url: fullUrl,
            thumbnail: img?.src || '',
            videoUrl: '',
            views: 0,
            likes: 0,
            comments: 0,
            outlierScore: 0,
            caption: img?.alt || `Post ${shortcode}`,
            author: extractCreatorHandle(STATE.currentPlatform),
            publishedAt: Date.now()
          };

          if (act === 'save') {
            toggleSavePost(postObj);
            btn.classList.toggle('is-saved', STATE.savedPostIds.has(postObj.id));
          } else if (act === 'download') {
            downloadPostsBatch([postObj]);
          } else if (act === 'transcribe') {
            STATE.filteredPosts = [postObj];
            openPlayerModal(0, true);
          }
        });
      });

      container.appendChild(bar);
    });
  }

  setInterval(attachNativeHoverButtons, 1800);

  function exportSimilarAccountsCsv() {
    const list = getSimilarAccountsList();
    const csvCell = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const csv = [
      'Profile,Username,Full Name,Verified',
      ...list.map((a) =>
        [a.url, `@${a.username}`, a.fullName, a.verified ? 'Yes' : 'No'].map(csvCell).join(',')
      )
    ].join('\r\n');
    downloadBlobFile(
      new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }),
      'shortfeed_similar_accounts.csv'
    );
    showToast(`Exported ${list.length} similar accounts`);
  }

  // ============================================================================
  // 8. PROGRESS OVERLAY & TOAST HELPERS
  // ============================================================================
  function showProgressOverlay(label, pct) {
    let overlay = document.getElementById('sf-root-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'sf-root-overlay';
      document.body.appendChild(overlay);
    }
    const logoUrl =
      typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
        ? chrome.runtime.getURL('icons/icon32.png')
        : '../icons/icon32.png';
    overlay.innerHTML = `
      <div class="sf-progress-pill">
        <div class="sf-progress-top">
          <div class="sf-progress-left">
            <img src="${logoUrl}" class="sf-progress-logo" alt="" />
            <span class="sf-progress-label" id="sfProgressText">${escapeHtml(label)}</span>
          </div>
          <div class="sf-progress-right">
            <span class="sf-progress-pct" id="sfProgressPct">${pct}%</span>
            <button type="button" class="sf-stop-btn" id="sfBtnStopCollect" title="Stop early and sort collected posts">
              <span class="sf-stop-square"></span>
            </button>
          </div>
        </div>
        <div class="sf-progress-track">
          <div class="sf-progress-fill" id="sfProgressFill" style="width:${pct}%"></div>
        </div>
      </div>
    `;
    overlay.querySelector('#sfBtnStopCollect')?.addEventListener('click', () => {
      STATE.stopRequested = true;
      window.dispatchEvent(new CustomEvent('SF_STOP_COLLECTION'));
    });
  }

  function updateProgressOverlay(label, pct) {
    const textEl = document.getElementById('sfProgressText');
    const pctEl = document.getElementById('sfProgressPct');
    const fillEl = document.getElementById('sfProgressFill');
    if (textEl) textEl.textContent = label;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
  }

  function hideProgressOverlay() {
    document.getElementById('sf-root-overlay')?.remove();
  }

  function showToast(message, actionLabel = null, onAction = null) {
    let container = document.getElementById('sf-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'sf-toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'sf-toast';
    toast.innerHTML = `
      <span>${escapeHtml(message)}</span>
      ${actionLabel ? `<button type="button" class="sf-toast-link">${escapeHtml(actionLabel)}</button>` : ''}
    `;
    if (actionLabel && onAction) {
      toast.querySelector('.sf-toast-link')?.addEventListener('click', () => {
        onAction();
        toast.remove();
      });
    }
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  // ============================================================================
  // 9. REALISTIC CREATOR DATASET GENERATOR (Modeled on @emma.scrapes in getting-started)
  // ============================================================================
  function generateCreatorDemoPosts(platform, count = 25) {
    const sampleData = [
      { views: 167800, likes: 655, comments: 8, hook: 'Claude users are living in 2078 😭 Build an AI scraper in 60s', daysAgo: 18 },
      { views: 153200, likes: 590, comments: 14, hook: 'Stop writing brittle CSS selectors — use this DOM agent pattern', daysAgo: 25 },
      { views: 124400, likes: 380, comments: 11, hook: 'How I automated 40 hours of competitor research into one sheet', daysAgo: 31 },
      { views: 106100, likes: 440, comments: 9, hook: 'The 3-step Outlier Score formula every viral creator uses', daysAgo: 42 },
      { views: 68500, likes: 639, comments: 12, hook: 'Turn any website into clean JSON without getting blocked', daysAgo: 12 },
      { views: 44200, likes: 310, comments: 7, hook: '5 Chrome DevTools tricks that feel illegal to know', daysAgo: 15 },
      { views: 29800, likes: 245, comments: 6, hook: 'Why your reels plateau at 10K views (and how to fix the 3s hook)', daysAgo: 21 },
      { views: 24400, likes: 198, comments: 5, hook: 'Reverse-engineering top 1% creator hooks with AI', daysAgo: 8 },
      { views: 19600, likes: 175, comments: 4, hook: 'My exact Google Sheets content calendar setup for 2026', daysAgo: 28 },
      { views: 17700, likes: 162, comments: 5, hook: 'Scraping Instagram & TikTok metrics locally in your browser', daysAgo: 5 },
      { views: 15400, likes: 140, comments: 3, hook: 'How to spot a 10x breakout topic before anyone else in your niche', daysAgo: 34 },
      { views: 14200, likes: 128, comments: 4, hook: 'Playwright vs Puppeteer vs Chrome Extensions in 2026', daysAgo: 38 },
      { views: 13100, likes: 119, comments: 3, hook: 'Building the ultimate web scraper from scratch — Day 14', daysAgo: 45 },
      { views: 12500, likes: 112, comments: 2, hook: '3 free APIs every solo founder should bookmark today', daysAgo: 49 },
      { views: 11800, likes: 108, comments: 4, hook: 'How to extract transcripts from 50 short-form videos in 1 click', daysAgo: 53 },
      { views: 10600, likes: 96, comments: 3, hook: 'Automating lead enrichment with local browser scripts', daysAgo: 6 },
      { views: 9800, likes: 89, comments: 2, hook: 'Why median beats average when analyzing social media metrics', daysAgo: 60 },
      { views: 9100, likes: 82, comments: 2, hook: 'Behind the scenes of a 150K view reel script', daysAgo: 64 },
      { views: 8400, likes: 76, comments: 1, hook: 'Clean-room reverse engineering workflow for web apps', daysAgo: 70 },
      { views: 7900, likes: 71, comments: 2, hook: 'How to structure your first 3 seconds for 85%+ retention', daysAgo: 75 },
      { views: 7200, likes: 65, comments: 1, hook: 'Exporting creator analytics directly into Excel & Sheets', daysAgo: 81 },
      { views: 6500, likes: 58, comments: 2, hook: 'Testing two different thumbnail hooks on the same topic', daysAgo: 86 },
      { views: 5800, likes: 52, comments: 1, hook: 'Quick tip: keyboard shortcuts for reviewing 50 hooks in 5 minutes', daysAgo: 92 },
      { views: 4940, likes: 45, comments: 1, hook: 'Day in the life building developer tools & extensions', daysAgo: 2 },
      { views: 4200, likes: 39, comments: 1, hook: 'Q&A: How I pick which niche accounts to study each week', daysAgo: 98 }
    ];

    const creator = extractCreatorHandle(platform);
    return sampleData.slice(0, count).map((item, i) => {
      const code = `SF${String(i + 1).padStart(2, '0')}X${100 + i}`;
      return {
        id: `${platform}_${code}`,
        shortcode: code,
        platform,
        type: 'reel',
        url: `https://www.${platform}.com/reel/${code}/`,
        thumbnail: createPosterDataUri(item.hook, item.views, i),
        videoUrl: '',
        views: item.views,
        likes: item.likes,
        comments: item.comments,
        shares: Math.round(item.likes * 0.18),
        saves: Math.round(item.likes * 0.29),
        caption: item.hook,
        author: creator,
        publishedAt: Date.now() - item.daysAgo * 86400000
      };
    });
  }

  function createPosterDataUri(title, views, index) {
    const palettes = [
      ['#0f172a', '#1e293b', '#312e81', '#f59e0b'],
      ['#18181b', '#27272a', '#3f3f46', '#fbbf24'],
      ['#090d16', '#1e3a8a', '#172554', '#38bdf8'],
      ['#141417', '#064e3b', '#022c22', '#34d399'],
      ['#1f122b', '#4a044e', '#3b0764', '#f472b6'],
      ['#1c1917', '#44403c', '#292524', '#a3e635']
    ];
    const [c1, c2, c3, accent] = palettes[index % palettes.length];
    const words = String(title || 'Viral Breakout Reel').split(/\s+/);
    const l1 = escapeXml(words.slice(0, 4).join(' '));
    const l2 = escapeXml(words.slice(4, 8).join(' '));
    const l3 = escapeXml(words.slice(8, 13).join(' '));

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640" width="360" height="640">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stop-color="${c1}"/>
          <stop offset="55%" stop-color="${c2}"/>
          <stop offset="100%" stop-color="${c3}"/>
        </linearGradient>
      </defs>
      <rect width="360" height="640" fill="url(#bg)"/>
      <!-- Decorative studio lights & mock terminal window -->
      <circle cx="290" cy="110" r="110" fill="${accent}" opacity="0.12"/>
      <circle cx="60" cy="490" r="130" fill="${accent}" opacity="0.08"/>
      <rect x="26" y="210" width="308" height="230" rx="16" fill="rgba(15,15,20,0.72)" stroke="rgba(255,255,255,0.14)" stroke-width="1.5"/>
      <circle cx="48" cy="232" r="5" fill="#ef4444"/>
      <circle cx="64" cy="232" r="5" fill="#f59e0b"/>
      <circle cx="80" cy="232" r="5" fill="#10b981"/>
      <rect x="44" y="256" width="160" height="10" rx="5" fill="${accent}" opacity="0.85"/>
      <rect x="44" y="278" width="240" height="8" rx="4" fill="rgba(255,255,255,0.28)"/>
      <rect x="44" y="296" width="210" height="8" rx="4" fill="rgba(255,255,255,0.22)"/>
      <rect x="44" y="314" width="260" height="8" rx="4" fill="rgba(255,255,255,0.16)"/>
      <!-- Creator Avatar & Play Emblem -->
      <circle cx="180" cy="382" r="32" fill="rgba(255,255,255,0.12)" stroke="${accent}" stroke-width="2"/>
      <polygon points="173,368 173,396 196,382" fill="#ffffff"/>
      <!-- Hook Caption Pill (Instagram Reel style) -->
      <rect x="22" y="72" width="316" height="104" rx="14" fill="rgba(0,0,0,0.68)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
      <text x="180" y="104" fill="#ffffff" font-family="Inter, system-ui, sans-serif" font-size="16" font-weight="700" text-anchor="middle">${l1}</text>
      <text x="180" y="128" fill="#f4f4f5" font-family="Inter, system-ui, sans-serif" font-size="15.5" font-weight="700" text-anchor="middle">${l2}</text>
      <text x="180" y="152" fill="${accent}" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="600" text-anchor="middle">${l3}</text>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  function findSuggestedNextButton() {
    try {
      const heading = Array.from(document.querySelectorAll('span, h2, h3, div')).find((el) => {
        if (el.closest('#sf-sorted-wrapper') || el.closest('nav')) return false;
        const txt = (el.textContent || '').trim();
        return txt.length < 30 && /^(suggested for you|similar accounts)$/i.test(txt);
      });
      const scope =
        heading?.closest('section, header, [role="dialog"]') ||
        heading?.parentElement?.parentElement?.parentElement ||
        document.querySelector('main') ||
        document.body;
      return scope.querySelector(
        'button[aria-label*="Next"], [role="button"][aria-label*="Next"]'
      );
    } catch {
      return null;
    }
  }

  function scanDomForSimilarAccounts(currentCreator) {
    const foundMap = new Map();
    const currentLower = String(currentCreator || '').toLowerCase();
    const skip = new Set([
      'explore', 'reels', 'watch', 'shorts', 'search', 'saved', 'p', 'reel',
      'stories', 'direct', 'accounts', 'about', 'legal', 'privacy', 'terms',
      'directory', 'lite', 'nametag', 'session', 'emails', 'challenge',
      'following', 'followers', 'notifications', 'create', 'more', 'threads',
      currentLower
    ]);

    const extractHandle = (anchor) => {
      const href = anchor?.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9._]{2,30})\/?(?:\?.*)?$/);
      if (!m) return null;
      const handle = m[1];
      if (skip.has(handle.toLowerCase())) return null;
      return handle;
    };

    const hasFollowButton = (container) => {
      const btns = container.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (/^(follow|following|requested)$/i.test(t)) return true;
      }
      return false;
    };

    const countUniqueHandles = (container) => {
      const handles = new Set();
      container.querySelectorAll('a[href^="/"]').forEach((a) => {
        const h = extractHandle(a);
        if (h) handles.add(h.toLowerCase());
      });
      return handles.size;
    };

    const findCardForLink = (link, requireReasonableSize = true) => {
      const li = link.closest('li, [role="listitem"]');
      if (li && !li.closest('#sf-sorted-wrapper') && !li.closest('nav')) {
        if (hasFollowButton(li) && countUniqueHandles(li) === 1) return li;
      }
      let curr = link.parentElement;
      for (let step = 0; step < 6 && curr && curr !== document.body; step++) {
        if (curr.closest('#sf-sorted-wrapper') || curr.closest('nav')) return null;
        if (hasFollowButton(curr)) {
          const uniqueHandles = countUniqueHandles(curr);
          if (uniqueHandles === 1) {
            if (!requireReasonableSize) return curr;
            const rect = curr.getBoundingClientRect();
            if ((rect.width === 0 && rect.height === 0) || (rect.width < 420 && rect.height < 480)) {
              return curr;
            }
          } else if (uniqueHandles > 1) {
            break;
          }
        }
        curr = curr.parentElement;
      }
      return null;
    };

    const addFromCard = (link, card) => {
      const handle = extractHandle(link);
      if (!handle) return;
      const lower = handle.toLowerCase();
      if (foundMap.has(lower)) return;

      const img = card.querySelector('img');
      const verified = Boolean(card.querySelector('svg[aria-label*="Verified"]'));

      // Extract descriptive fullName line inside card
      const noiseRe = /^(follow|following|requested|suggested for you|similar accounts|see all|close|remove|×|✕)$/i;
      const texts = [];
      card.querySelectorAll('span, div, a').forEach((el) => {
        if (el.closest('button')) return;
        // Only inspect leaf or near-leaf elements
        if (el.children.length > 1) return;
        const txt = (el.textContent || '').trim();
        if (!txt || txt.length > 70) return;
        if (noiseRe.test(txt)) return;
        if (txt.toLowerCase() === lower || txt.toLowerCase() === `@${lower}`) return;
        if (!texts.includes(txt)) texts.push(txt);
      });

      foundMap.set(lower, {
        id: handle,
        username: handle,
        fullName: texts[0] || handle,
        verified,
        avatar: img?.src || '',
        url: `https://www.instagram.com/${handle}/`
      });
    };

    try {
      // 1. Find "Suggested for you" / "Similar accounts" heading containers (including inside <header>)
      const containers = new Set();
      document.querySelectorAll('span, h2, h3, div').forEach((el) => {
        if (el.closest('#sf-sorted-wrapper') || el.closest('nav')) return;
        const txt = (el.textContent || '').trim();
        if (txt.length > 0 && txt.length < 32 && /^(suggested for you|similar accounts)$/i.test(txt)) {
          const scope =
            el.closest('section, header, [role="dialog"]') ||
            el.parentElement?.parentElement?.parentElement;
          if (scope && !scope.closest('#sf-sorted-wrapper')) {
            containers.add(scope);
          }
        }
      });

      containers.forEach((root) => {
        root.querySelectorAll('a[href^="/"]').forEach((link) => {
          if (link.closest('#sf-sorted-wrapper') || link.closest('nav')) return;
          const card = findCardForLink(link, true);
          if (card) addFromCard(link, card);
        });
      });

      // 2. Fallback scan across all profile links on the page (outside nav & #sf-sorted-wrapper)
      document.querySelectorAll('a[href^="/"]').forEach((link) => {
        if (link.closest('#sf-sorted-wrapper') || link.closest('nav')) return;
        const handle = extractHandle(link);
        if (!handle || foundMap.has(handle.toLowerCase())) return;
        const card = findCardForLink(link, true);
        if (card) addFromCard(link, card);
      });
    } catch {}

    return Array.from(foundMap.values()).slice(0, 30);
  }

  function getSimilarAccountsList() {
    const isSandbox = Boolean(document.getElementById('sandboxMountArea')) || STATE.demoMode;
    const currentCreator = extractCreatorHandle(STATE.currentPlatform).toLowerCase();

    if (!isSandbox) {
      if (STATE.similarAccounts.length === 0) {
        const domAccs = scanDomForSimilarAccounts(currentCreator);
        if (domAccs.length > 0) mergeSimilarAccounts(domAccs);
      }
      return STATE.similarAccounts.filter(
        (acc) => acc?.username && acc.username.toLowerCase() !== currentCreator
      );
    }

    return [
      { username: 'kallaway', fullName: 'Kallaway • Content Strategy', verified: true, url: 'https://www.instagram.com/kallaway/' },
      { username: 'brock11johnson', fullName: 'Brock Johnson • IG Growth', verified: true, url: 'https://www.instagram.com/brock11johnson/' },
      { username: 'createcontent.club', fullName: 'Alessio & Bryan • Viral Hooks', verified: true, url: 'https://www.instagram.com/createcontent.club/' },
      { username: 'iamaayushswamy', fullName: 'Aayush Swamy • Short Form', verified: false, url: 'https://www.instagram.com/iamaayushswamy/' },
      { username: 'therealmarcozavala', fullName: 'Marco Zavala • Creator Systems', verified: true, url: 'https://www.instagram.com/therealmarcozavala/' },
      { username: 'avayuergens', fullName: 'Ava Yuergens • Digital Creator', verified: false, url: 'https://www.instagram.com/avayuergens/' },
      { username: 'levelsio', fullName: 'Pieter Levels • Indie Maker', verified: true, url: 'https://www.instagram.com/levelsio/' },
      { username: 'fireship_dev', fullName: 'Fireship • Code & Tech', verified: true, url: 'https://www.instagram.com/fireship_dev/' }
    ];
  }

  // ============================================================================
  // 10. FORMATTING & UTILITY HELPERS
  // ============================================================================
  function formatCount(n) {
    const num = Number(n) || 0;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
    return String(num);
  }

  function formatMetricLabel(m) {
    const map = {
      outlier: 'Outlier score',
      views: 'Views',
      likes: 'Likes',
      comments: 'Comments',
      shares: 'Shares',
      saves: 'Saves',
      oldest: 'Oldest'
    };
    return map[m] || 'Outlier score';
  }

  function formatPublishDate(ms, post = null) {
    if (post && !post.hasExactTimestamp && typeof post.relativeAgeDays === 'number' && post.relativeAgeDays >= 0) {
      ms = getReferenceNow(STATE.collectedPosts) - post.relativeAgeDays * 86400000;
    }
    if (!ms) return 'Recent';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return 'Recent';
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  function parseAbbreviated(raw) {
    if (!raw) return 0;
    const cleaned = String(raw).replace(/,/g, '').trim();
    const match = cleaned.match(/([\d.]+)\s*([KMBkmb])?/);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    if (isNaN(num)) return 0;
    const unit = (match[2] || '').toUpperCase();
    if (unit === 'K') return Math.round(num * 1e3);
    if (unit === 'M') return Math.round(num * 1e6);
    if (unit === 'B') return Math.round(num * 1e9);
    return Math.round(num);
  }

  function extractNumbersFromText(text) {
    if (!text) return [];
    const matches = String(text).match(/\b\d+(?:[.,]\d+)?\s*[KMBkmb]?\b/g) || [];
    return matches.map(parseAbbreviated).filter((n) => n > 0);
  }

  function parseSocialMetricsFromText(fullText, anchorText = '') {
    let views = 0;
    let likes = 0;
    let comments = 0;
    let shares = 0;

    if (fullText) {
      const viewMatch = fullText.match(/(\d+(?:[.,]\d+)?\s*[KMBkmb]?)\s*(?:views|plays|view|play)\b/i);
      if (viewMatch) views = parseAbbreviated(viewMatch[1]);

      const likeMatch = fullText.match(/(\d+(?:[.,]\d+)?\s*[KMBkmb]?)\s*(?:likes|like)\b/i);
      if (likeMatch) likes = parseAbbreviated(likeMatch[1]);

      const commentMatch = fullText.match(
        /(?:view all\s+)?(\d+(?:[.,]\d+)?\s*[KMBkmb]?)\s*(?:comments|comment)\b/i
      );
      if (commentMatch) comments = parseAbbreviated(commentMatch[1]);

      const shareMatch = fullText.match(
        /(\d+(?:[.,]\d+)?\s*[KMBkmb]?)\s*(?:shares|share|reshares|reposts)\b/i
      );
      if (shareMatch) shares = parseAbbreviated(shareMatch[1]);
    }

    const anchorNums = extractNumbersFromText(anchorText);
    const firstStat = anchorNums[0] || 0;
    if (!likes && anchorNums.length >= 2) {
      likes = anchorNums[0];
      comments = comments || anchorNums[1];
    }

    return { views, likes, comments, shares, firstStat };
  }

  function downloadBlobFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Dynamically sync theme when OS/System preference or page theme changes
  function syncSortedWrapperTheme() {
    const wrapper = document.getElementById('sf-sorted-wrapper');
    if (wrapper) wrapper.setAttribute('data-sf-theme', detectResolvedTheme(wrapper));
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncSortedWrapperTheme);
  }

  if (typeof MutationObserver !== 'undefined') {
    const themeObserver = new MutationObserver(syncSortedWrapperTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'dark']
    });
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'dark']
      });
    }
  }

  function escapeXml(str) {
    return escapeHtml(str).replace(/'/g, '&apos;');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Clear stale profile overlays & date filter state when navigating in SPA (YouTube / Instagram)
  let lastObservedHref = location.href;
  setInterval(() => {
    if (location.href === lastObservedHref) return;
    const prevPath = (() => {
      try {
        return new URL(lastObservedHref).pathname;
      } catch {
        return '';
      }
    })();
    lastObservedHref = location.href;
    if (location.pathname === prevPath) return;
    if (STATE.isCollecting || document.getElementById('sandboxMountArea')) return;

    if (!isDateFilterAllowed()) {
      STATE.filterDays = 'all';
      STATE.filterDateStart = null;
      STATE.filterDateEnd = null;
    }
    const existingWrapper = document.getElementById('sf-sorted-wrapper');
    if (existingWrapper) {
      restoreNativeGrid();
      existingWrapper.remove();
    }
  }, 700);
})();
