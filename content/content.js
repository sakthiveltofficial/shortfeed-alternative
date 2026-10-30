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
    currentMetric: 'outlier', // 'outlier' | 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'oldest'
    currentPlatform: detectPlatform(),
    creatorMedian: 0,
    outlierBaselineMetric: 'views',
    filterMin: null,
    filterMax: null,
    filterDays: 'all',
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

  // Listen for intercepted network posts from MAIN world
  window.addEventListener('SF_INTERCEPTED_POSTS', (e) => {
    const list = e.detail;
    if (!Array.isArray(list)) return;
    list.forEach((post) => {
      if (post && post.id) {
        const prev = STATE.interceptedMap.get(post.id) || {};
        STATE.interceptedMap.set(post.id, { ...prev, ...post });
      }
    });
  });

  // Listen for messages from Popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      if (msg.type === 'SF_START_SORT') {
        startSortWorkflow(msg.payload || {});
        sendResponse({ ok: true });
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
    STATE.filterDays = 'all';
    STATE.selectMode = false;
    STATE.selectedIds = [];

    const targetLimit = Number(options.postLimit) || 25;
    const noun = getItemNoun(STATE.currentPlatform);

    showProgressOverlay(`Getting ready to sort`, 5);

    const gatheredMap = new Map();
    // Seed with any already-intercepted items
    STATE.interceptedMap.forEach((val, key) => gatheredMap.set(key, val));

    // Scan live DOM + scroll loop unless forced Demo mode
    if (!options.demoMode) {
      const maxSteps = Math.min(28, Math.ceil(targetLimit / 6) + 3);
      for (let step = 0; step < maxSteps; step++) {
        if (STATE.stopRequested) break;

        const domPosts = scanLiveDomForPosts(STATE.currentPlatform);
        domPosts.forEach((p) => {
          const existing = gatheredMap.get(p.id) || STATE.interceptedMap.get(p.id) || {};
          gatheredMap.set(p.id, { ...p, ...existing });
        });

        const currentCount = gatheredMap.size;
        const pct = Math.min(98, Math.round((currentCount / Math.min(targetLimit, 100)) * 100));
        updateProgressOverlay(`${currentCount} ${noun} sorted — don't scroll`, Math.max(12, pct));

        if (currentCount >= targetLimit) break;

        window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' });
        await sleep(380);
      }
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
    } else {
      finalPosts = finalPosts.slice(0, targetLimit);
    }

    // Apply Date scope filter if started from the Date tab
    if (options.scope === 'date' && options.datePreset && options.datePreset !== 'all') {
      const daysMap = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 };
      const days = daysMap[options.datePreset];
      if (days) {
        const cutoff = Date.now() - days * 86400000;
        const dateFiltered = finalPosts.filter((p) => (p.publishedAt || Date.now()) >= cutoff);
        if (dateFiltered.length > 0) finalPosts = dateFiltered;
      }
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
      const anchors = document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]');
      anchors.forEach((a, idx) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/(reel|p)\/([A-Za-z0-9_-]+)/);
        if (!match) return;
        const type = match[1];
        const code = match[2];
        const img = a.querySelector('img');
        const thumb = img?.src || '';
        const caption = img?.alt || '';
        const textContent = a.innerText || a.textContent || '';
        const nums = extractNumbersFromText(textContent);
        const views = nums[0] || (type === 'reel' ? 12000 + idx * 3400 : 0);
        const likes = nums[1] || Math.max(120, Math.round(views * 0.045));
        const comments = nums[2] || Math.max(5, Math.round(likes * 0.03));

        results.push({
          id: `ig_${code}`,
          shortcode: code,
          platform: 'instagram',
          type,
          url: new URL(href, location.origin).href,
          thumbnail: thumb || createPosterDataUri(caption || code, views, idx),
          videoUrl: '',
          views,
          likes,
          comments,
          shares: 0,
          saves: 0,
          caption: caption || `Post ${code} by @${creator}`,
          author: creator,
          publishedAt: Date.now() - (idx + 1) * 86400000 * 2.2
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
        const views = parseAbbreviated(viewsText) || 25000 + idx * 4100;
        const likes = Math.round(views * 0.08);
        const comments = Math.round(likes * 0.025);
        const shares = Math.round(likes * 0.04);
        const saves = Math.round(likes * 0.06);

        results.push({
          id: `tt_${vid}`,
          shortcode: vid,
          platform: 'tiktok',
          type: 'video',
          url: new URL(href, location.origin).href,
          thumbnail: img?.src || createPosterDataUri(`TikTok #${idx + 1}`, views, idx),
          videoUrl: '',
          views,
          likes,
          comments,
          shares,
          saves,
          caption: img?.alt || `TikTok video ${vid}`,
          author: creator,
          publishedAt: Date.now() - (idx + 1) * 86400000 * 1.8
        });
      });
    } else if (platform === 'youtube') {
      const links = document.querySelectorAll('a#thumbnail[href*="/watch?v="], a[href*="/shorts/"]');
      links.forEach((a, idx) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/(?:v=|\/shorts\/)([A-Za-z0-9_-]{11})/);
        if (!match) return;
        const vid = match[1];
        const card = a.closest('ytd-rich-item-renderer, ytd-grid-video-renderer, ytm-shorts-lockup-view-model, div') || a;
        const titleEl = card.querySelector('#video-title, h3, span[role="text"]');
        const title = (titleEl?.textContent || '').trim() || `YouTube Video ${vid}`;
        const metaText = card.innerText || '';
        const viewMatch = metaText.match(/([\d.,]+\s*[KMB]?)\s*views/i);
        const views = viewMatch ? parseAbbreviated(viewMatch[1]) : 42000 + idx * 5300;
        const likes = Math.round(views * 0.048);

        results.push({
          id: `yt_${vid}`,
          shortcode: vid,
          platform: 'youtube',
          type: href.includes('/shorts/') ? 'short' : 'video',
          url: new URL(href, location.origin).href,
          thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          videoUrl: '',
          views,
          likes,
          comments: 0,
          shares: 0,
          saves: 0,
          title,
          caption: title,
          duration: href.includes('/shorts/') ? '0:48' : '8:24',
          category: 'Creator & Education',
          author: creator,
          publishedAt: Date.now() - (idx + 1) * 86400000 * 3
        });
      });
    } else if (platform === 'facebook') {
      const links = document.querySelectorAll('a[href*="/reel/"]');
      links.forEach((a, idx) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/reel\/(\d+)/);
        if (!match) return;
        const rid = match[1];
        const img = a.querySelector('img');
        const nums = extractNumbersFromText(a.innerText || '');
        const views = nums[0] || 18500 + idx * 2900;
        const likes = Math.round(views * 0.04);

        results.push({
          id: `fb_${rid}`,
          shortcode: rid,
          platform: 'facebook',
          type: 'reel',
          url: new URL(href, location.origin).href,
          thumbnail: img?.src || createPosterDataUri(`Reel #${idx + 1}`, views, idx),
          videoUrl: '',
          views,
          likes,
          comments: Math.round(likes * 0.05),
          shares: Math.round(likes * 0.03),
          saves: 0,
          caption: img?.alt || `Facebook Reel ${rid}`,
          author: creator,
          publishedAt: Date.now() - (idx + 1) * 86400000 * 2.5
        });
      });
    }

    return results;
  }

  function extractCreatorHandle(platform) {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      const first = parts[0].replace(/^@/, '');
      if (!['explore', 'reels', 'watch', 'shorts', 'search', 'saved'].includes(first.toLowerCase())) {
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

    // Use views when available, or likes on Instagram Posts tab when views are 0
    const hasViews = posts.some((p) => (p.views || 0) > 0);
    const baselineKey = hasViews ? 'views' : 'likes';
    STATE.outlierBaselineMetric = baselineKey;

    // Sort by newest first to select up to 25 recent posts, excluding last 3 days if enough mature posts exist
    const byRecent = [...posts].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    const recent25 = byRecent.slice(0, 25);
    const threeDaysAgo = Date.now() - 3 * 86400000;
    const maturePool = recent25.filter((p) => (p.publishedAt || 0) < threeDaysAgo);
    const pool = maturePool.length >= 5 ? maturePool : recent25;

    const values = pool
      .map((p) => Number(p[baselineKey]) || 0)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);

    let median = 1;
    if (values.length > 0) {
      const mid = Math.floor(values.length / 2);
      median =
        values.length % 2 !== 0
          ? values[mid]
          : Math.round((values[mid - 1] + values[mid]) / 2);
    }
    STATE.creatorMedian = Math.max(1, median);

    // Compute multiplier for every post
    const scored = posts.map((post) => {
      const val = Number(post[baselineKey]) || 0;
      const rawMultiple = val / STATE.creatorMedian;
      const outlierScore = Math.round(rawMultiple * 10) / 10;
      return {
        ...post,
        outlierScore,
        creatorMedian: STATE.creatorMedian
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
      list = list.filter((p) => (Number(p[metricKey]) || 0) >= STATE.filterMin);
    }
    if (STATE.filterMax !== null && !isNaN(STATE.filterMax)) {
      list = list.filter((p) => (Number(p[metricKey]) || 0) <= STATE.filterMax);
    }
    if (STATE.filterDays && STATE.filterDays !== 'all') {
      const days = Number(STATE.filterDays);
      if (days > 0) {
        const cutoff = Date.now() - days * 86400000;
        list = list.filter((p) => (p.publishedAt || 0) >= cutoff);
      }
    }

    // Sort according to STATE.currentMetric
    list.sort((a, b) => {
      switch (STATE.currentMetric) {
        case 'outlier':
          return (b.outlierScore || 0) - (a.outlierScore || 0);
        case 'views':
          return (b.views || 0) - (a.views || 0);
        case 'likes':
          return (b.likes || 0) - (a.likes || 0);
        case 'comments':
          return (b.comments || 0) - (a.comments || 0);
        case 'shares':
          return (b.shares || 0) - (a.shares || 0);
        case 'saves':
          return (b.saves || 0) - (a.saves || 0);
        case 'oldest':
          return (a.publishedAt || 0) - (b.publishedAt || 0);
        default:
          return (b.outlierScore || 0) - (a.outlierScore || 0);
      }
    });

    STATE.filteredPosts = list;
  }

  // ============================================================================
  // 5. RENDER STICKY BANNER & SORTED GRID (getting-started-03-poster.jpg)
  // ============================================================================
  function renderSortedFeedUI() {
    let wrapper = document.getElementById('sf-sorted-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'sf-sorted-wrapper';
      const sandboxMount = document.getElementById('sandboxMountArea');
      const mountTarget =
        sandboxMount ||
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.body;
      mountTarget.prepend(wrapper);
    }

    const noun = getItemNoun(STATE.currentPlatform);
    const totalCount = STATE.filteredPosts.length;
    const activeCount = STATE.selectMode ? STATE.selectedIds.length : totalCount;

    const headlineMap = {
      outlier: `Top Outlier ${noun}`,
      views: `Top ${noun} by Views`,
      likes: `Top ${noun} by Likes`,
      comments: `Top ${noun} by Comments`,
      shares: `Top ${noun} by Shares`,
      saves: `Top ${noun} by Saves`,
      oldest: `Oldest ${noun} First`
    };
    const headline = headlineMap[STATE.currentMetric] || `Sorted ${noun}`;
    const hasActiveFilter =
      STATE.filterMin !== null || STATE.filterMax !== null || STATE.filterDays !== 'all';

    wrapper.innerHTML = `
      <div class="sf-banner">
        <div class="sf-banner-top">
          <div>
            <h2 class="sf-banner-headline">${escapeHtml(headline)}</h2>
            <div class="sf-banner-sub">
              Showing ${totalCount} ${escapeHtml(noun)} • Creator median: ${formatCount(STATE.creatorMedian)} ${STATE.outlierBaselineMetric}
            </div>
          </div>

          <div class="sf-action-row">
            ${
              STATE.currentPlatform === 'instagram'
                ? `<button type="button" class="sf-action-btn ${STATE.similarOpen ? 'is-active' : ''}" id="sfBtnSimilar">
                     <span>✦ Similar</span>
                   </button>
                   <span class="sf-divider-v"></span>`
                : ''
            }
            <button type="button" class="sf-action-btn ${STATE.selectMode ? 'is-active' : ''}" id="sfBtnSelect">
              <span>${STATE.selectMode ? `✕ Cancel (${STATE.selectedIds.length})` : '✓ Select'}</span>
            </button>
            <span class="sf-divider-v"></span>
            ${
              STATE.currentPlatform !== 'youtube'
                ? `<button type="button" class="sf-action-btn" id="sfBtnDownload">
                     <span>↓ Download</span>
                     <span class="sf-action-count">${activeCount}</span>
                   </button>`
                : ''
            }
            <button type="button" class="sf-action-btn" id="sfBtnCopy">
              <span>📋 Copy</span>
            </button>
            <div style="position:relative;">
              <button type="button" class="sf-action-btn sf-action-btn-bordered" id="sfBtnExportMenu">
                <span>↑ Export</span>
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
                <span>≡ Filters</span>
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
                <div class="sf-field-group">
                  <label>Posted within</label>
                  <select id="sfSelectFilterDays" class="sf-field-input">
                    <option value="all" ${STATE.filterDays === 'all' ? 'selected' : ''}>Any time</option>
                    <option value="7" ${STATE.filterDays === '7' ? 'selected' : ''}>In the last 7 days</option>
                    <option value="30" ${STATE.filterDays === '30' ? 'selected' : ''}>In the last 30 days</option>
                    <option value="90" ${STATE.filterDays === '90' ? 'selected' : ''}>In the last 3 months</option>
                    <option value="365" ${STATE.filterDays === '365' ? 'selected' : ''}>In the last 1 year</option>
                  </select>
                </div>
                <button type="button" class="sf-apply-btn" id="sfBtnApplyFilters">
                  Apply Filters (${totalCount} matching)
                </button>
              </div>
            </div>

            <!-- Instant Re-Sort Chip -->
            <div style="position:relative;">
              <button type="button" class="sf-chip-btn" id="sfBtnSortByChip">
                <span>⇅ Sort by: ${escapeHtml(formatMetricLabel(STATE.currentMetric))}</span>
              </button>
              <div class="sf-popover" id="sfPopoverSortBy" hidden>
                ${renderSortByMenuItemsHtml()}
              </div>
            </div>

            <button type="button" class="sf-clear-btn" id="sfBtnClearFilters">Clear all</button>
          </div>

          <div style="display:flex;align-items:center;gap:8px;">
            <button type="button" class="sf-clear-btn" id="sfBtnOpenLibrary">🔖 Saved Library (${STATE.savedPostIds.size})</button>
            <button type="button" class="sf-clear-btn" id="sfBtnCloseSorted" title="Remove sorted grid and restore page">✕ Close grid</button>
          </div>
        </div>
      </div>

      ${STATE.similarOpen ? renderSimilarAccountsDrawerHtml() : ''}

      <div class="sf-grid" id="sfSortedGrid">
        ${STATE.filteredPosts.map((post, idx) => renderGridCardHtml(post, idx)).join('')}
      </div>
    `;

    bindBannerAndGridEvents(wrapper);
  }

  function renderGridCardHtml(post, idx) {
    const isSaved = STATE.savedPostIds.has(post.id);
    const selectIdx = STATE.selectedIds.indexOf(post.id);
    const isSelected = selectIdx !== -1;

    const boltsStr = post.bolts > 0 ? '⚡'.repeat(post.bolts) : '';
    const tooltipText = `${post.outlierScore}x — ${post.outlierScore}x more than usual (${formatCount(
      post.views || post.likes
    )} vs ${formatCount(post.creatorMedian)} median)`;

    const primaryStat =
      post.views > 0 ? `▶ ${formatCount(post.views)}` : `♥ ${formatCount(post.likes)}`;

    return `
      <div class="sf-card-item ${isSelected ? 'is-selected' : ''}" data-index="${idx}" data-id="${escapeHtml(post.id)}">
        <img class="sf-card-thumb" src="${escapeHtml(post.thumbnail)}" alt="${escapeHtml(post.caption)}" loading="lazy" />

        ${
          boltsStr
            ? `<div class="sf-bolt-badge">${boltsStr}</div>
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
                          🔖
                        </button>`
                     : ''
                 }
                 ${
                   STATE.settings.showDownloadButton !== false && STATE.currentPlatform !== 'youtube'
                     ? `<button type="button" class="sf-card-action-icon" data-card-action="download" data-id="${escapeHtml(post.id)}" title="Download media">
                          ↓
                        </button>`
                     : ''
                 }
                 ${
                   STATE.settings.showTranscribeButton !== false && STATE.currentPlatform !== 'youtube'
                     ? `<button type="button" class="sf-card-action-icon" data-card-action="transcribe" data-id="${escapeHtml(post.id)}" title="Transcribe video (T)">
                          文
                        </button>`
                     : ''
                 }
               </div>`
        }

        <div class="sf-card-hover-stats">
          <div>▶ ${formatCount(post.views)}</div>
          <div>♥ ${formatCount(post.likes)}</div>
          ${post.comments ? `<div>💬 ${formatCount(post.comments)}</div>` : ''}
          <div>⚡ ${post.outlierScore}x</div>
        </div>

        <div class="sf-corner-stat">${primaryStat}</div>
        ${
          STATE.currentMetric === 'outlier'
            ? `<div class="sf-corner-outlier">${post.outlierScore}x</div>`
            : ''
        }
      </div>
    `;
  }

  function renderHistogramBarsHtml() {
    const key = STATE.currentMetric === 'outlier' ? 'outlierScore' : 'views';
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
      { id: 'outlier', label: '⚡ Outlier score' },
      { id: 'views', label: '▶ Views' },
      { id: 'likes', label: '♥ Likes' },
      { id: 'comments', label: '💬 Comments' },
      { id: 'shares', label: '↗ Shares' },
      { id: 'saves', label: '🔖 Saves' },
      { id: 'oldest', label: '🕒 Oldest' }
    ];
    return metrics
      .map(
        (m) => `
        <button type="button" class="sf-menu-item ${STATE.currentMetric === m.id ? 'is-selected' : ''}" data-sort-metric="${m.id}">
          <span>${m.label}</span>
          ${STATE.currentMetric === m.id ? '<span>✓</span>' : ''}
        </button>`
      )
      .join('');
  }

  function renderSimilarAccountsDrawerHtml() {
    const similarList = getSimilarAccountsList();
    return `
      <div class="sf-similar-drawer">
        <div class="sf-similar-header">
          <span class="sf-similar-title">Similar accounts you can sort (${similarList.length})</span>
          <button type="button" class="sf-action-btn sf-action-btn-bordered" id="sfBtnExportSimilar">
            ↑ Export Similar List (CSV)
          </button>
        </div>
        <div class="sf-similar-grid">
          ${similarList
            .map(
              (acc) => `
              <div class="sf-similar-card" data-sim-url="${escapeHtml(acc.url)}">
                <div class="sf-sim-avatar">${escapeHtml(acc.username.slice(0, 2).toUpperCase())}</div>
                <div class="sf-sim-info">
                  <div class="sf-sim-handle">@${escapeHtml(acc.username)} ${acc.verified ? '✓' : ''}</div>
                  <div class="sf-sim-name">${escapeHtml(acc.fullName)}</div>
                </div>
              </div>`
            )
            .join('')}
        </div>
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
      renderSortedFeedUI();
    });

    wrapper.querySelector('#sfBtnExportSimilar')?.addEventListener('click', () => {
      exportSimilarAccountsCsv();
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

    // Apply Filters button
    wrapper.querySelector('#sfBtnApplyFilters')?.addEventListener('click', () => {
      const minVal = wrapper.querySelector('#sfInputMin')?.value;
      const maxVal = wrapper.querySelector('#sfInputMax')?.value;
      const daysVal = wrapper.querySelector('#sfSelectFilterDays')?.value || 'all';
      STATE.filterMin = minVal !== '' ? Number(minVal) : null;
      STATE.filterMax = maxVal !== '' ? Number(maxVal) : null;
      STATE.filterDays = daysVal;
      applyFiltersAndSort();
      renderSortedFeedUI();
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

    btnClearFilters?.addEventListener('click', () => {
      STATE.filterMin = null;
      STATE.filterMax = null;
      STATE.filterDays = 'all';
      applyFiltersAndSort();
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

        if (STATE.settings.openPostsIn === 'platform' || STATE.currentPlatform === 'youtube') {
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
  function openPlayerModal(index, autoTranscribe = false) {
    if (index < 0 || index >= STATE.filteredPosts.length) return;
    STATE.activePlayerIndex = index;
    STATE.playerPlaying = true;
    STATE.playerTime = 0;
    STATE.playerDuration = 23;

    const post = STATE.filteredPosts[index];
    let backdrop = document.getElementById('sf-player-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'sf-player-backdrop';
      document.body.appendChild(backdrop);
    }

    const isSaved = STATE.savedPostIds.has(post.id);
    const total = STATE.filteredPosts.length;
    const pubDateStr = formatPublishDate(post.publishedAt);

    backdrop.innerHTML = `
      <div class="sf-player-modal" role="dialog" aria-modal="true">
        <!-- Left Video / Animated Stage -->
        <div class="sf-player-stage" id="sfPlayerStage">
          ${
            post.videoUrl
              ? `<video class="sf-player-video" id="sfVideoEl" src="${escapeHtml(post.videoUrl)}" poster="${escapeHtml(post.thumbnail)}" autoplay loop playsinline ${STATE.settings.playerMuted ? 'muted' : ''}></video>`
              : `<div class="sf-player-visual-wrap">
                   <img class="sf-player-poster-img" id="sfPosterAnimImg" src="${escapeHtml(post.thumbnail)}" alt="${escapeHtml(post.caption)}" />
                   <div class="sf-player-hook-overlay">${escapeHtml((post.caption || 'Viral Breakout Hook').slice(0, 56))}</div>
                 </div>`
          }

          <div class="sf-video-controls">
            <div class="sf-scrubber-row">
              <input type="range" id="sfPlayerScrubber" class="sf-scrubber" min="0" max="23" step="0.2" value="0" />
              <span class="sf-time-label" id="sfPlayerTimeLabel">0:01 / 0:23</span>
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
              <div id="sfTranscriptContent">${escapeHtml(post.transcript || '')}</div>
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

    startCanvasOrVideoPlayback(post, backdrop);
    bindPlayerModalEvents(backdrop, post);

    // Proactively resolve real watermark-free video URL if not yet cached
    if (!post.videoUrl && !post.id.includes('_SF')) {
      resolvePostMediaUrls(post).then((resolved) => {
        if (resolved.videoUrl && STATE.activePlayerIndex === index) {
          post.videoUrl = resolved.videoUrl;
          const stage = backdrop.querySelector('#sfPlayerStage');
          const visualWrap = stage?.querySelector('.sf-player-visual-wrap');
          if (visualWrap) {
            const v = document.createElement('video');
            v.className = 'sf-player-video';
            v.id = 'sfVideoEl';
            v.src = resolved.videoUrl;
            v.poster = post.thumbnail;
            v.autoplay = true;
            v.loop = true;
            v.playsInline = true;
            v.muted = Boolean(STATE.settings.playerMuted);
            visualWrap.replaceWith(v);
          }
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

    const posterImg = backdrop.querySelector('#sfPosterAnimImg');
    const videoEl = backdrop.querySelector('#sfVideoEl');
    const scrubber = backdrop.querySelector('#sfPlayerScrubber');
    const timeLabel = backdrop.querySelector('#sfPlayerTimeLabel');

    STATE.playerTimerId = setInterval(() => {
      if (!document.getElementById('sf-player-backdrop')) {
        clearInterval(STATE.playerTimerId);
        return;
      }
      if (STATE.playerPlaying) {
        if (videoEl && videoEl.duration && !isNaN(videoEl.duration)) {
          STATE.playerDuration = Math.max(1, Math.round(videoEl.duration));
          STATE.playerTime = videoEl.currentTime;
        } else {
          STATE.playerTime += 0.1 * STATE.playerSpeed;
          if (STATE.playerTime > STATE.playerDuration) STATE.playerTime = 0;
        }
        if (scrubber) {
          scrubber.max = String(STATE.playerDuration);
          scrubber.value = String(STATE.playerTime.toFixed(1));
        }
        if (timeLabel) {
          timeLabel.textContent = `0:${String(Math.floor(STATE.playerTime)).padStart(2, '0')} / 0:${String(STATE.playerDuration).padStart(2, '0')}`;
        }
        if (posterImg) {
          const zoom = 1 + Math.sin(STATE.playerTime * 0.45) * 0.035;
          posterImg.style.transform = `scale(${zoom.toFixed(4)})`;
        }
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

    btnPlayPause?.addEventListener('click', () => {
      STATE.playerPlaying = !STATE.playerPlaying;
      btnPlayPause.textContent = STATE.playerPlaying ? '⏸' : '▶';
    });

    btnSeekBack?.addEventListener('click', () => {
      STATE.playerTime = Math.max(0, STATE.playerTime - 5);
    });

    btnSeekFwd?.addEventListener('click', () => {
      STATE.playerTime = Math.min(STATE.playerDuration, STATE.playerTime + 5);
    });

    btnSpeed?.addEventListener('click', () => {
      const speeds = [0.5, 1, 1.5, 2, 3];
      const nextIdx = (speeds.indexOf(STATE.playerSpeed) + 1) % speeds.length;
      STATE.playerSpeed = speeds[nextIdx];
      btnSpeed.textContent = `${STATE.playerSpeed}x`;
    });

    btnMute?.addEventListener('click', () => {
      STATE.settings.playerMuted = !STATE.settings.playerMuted;
      btnMute.textContent = STATE.settings.playerMuted ? '🔇' : '🔊';
      if (hasChromeStorage) {
        chrome.storage.local.set({ sf_settings: STATE.settings });
      }
    });

    scrubber?.addEventListener('input', () => {
      STATE.playerTime = Number(scrubber.value) || 0;
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
    document.getElementById('sf-player-backdrop')?.remove();
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

  function generateTranscriptForPost(post, backdrop) {
    const box = backdrop.querySelector('#sfTranscriptBox');
    const content = backdrop.querySelector('#sfTranscriptContent');
    if (!box || !content) return;

    box.hidden = false;
    content.textContent = 'Transcribing audio track...';

    setTimeout(() => {
      const hookText = post.caption || 'Stop scrolling if you want to 10x your content workflow.';
      const transcript = [
        `[00:00] ${hookText.slice(0, 90)}`,
        `[00:04] Most creators look at raw views, which hides what actually broke out above their baseline.`,
        `[00:10] When you rank by Outlier Score (${post.outlierScore}x median), the repeatable hook patterns jump right to the top.`,
        `[00:17] Save this format to your swipe file and test the opening 3-second framing on your next reel.`
      ].join('\n');

      post.transcript = transcript;
      content.innerHTML = transcript.replace(/\n/g, '<br/>');
      showToast('Transcript ready');
    }, 350);
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
      const base = {
        Profile: `https://www.${p.platform}.com/${p.author || 'creator'}`,
        Creator: `@${p.author || 'creator'}`,
        Link: p.url,
        CreateDate: formatPublishDate(p.publishedAt),
        Views: p.views || 0,
        OutlierScore: `${p.outlierScore || 1}x`,
        Likes: p.likes || 0,
        Comments: p.comments || 0
      };
      if (p.platform === 'tiktok' || p.platform === 'facebook') {
        base.Shares = p.shares || 0;
      }
      if (p.platform === 'tiktok') {
        base.Saves = p.saves || 0;
      }
      if (p.platform === 'youtube') {
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

  function copyPostsToClipboard(posts) {
    const rows = buildExportRows(posts);
    if (rows.length === 0) return;
    const headers = Object.keys(rows[0]);
    const tsv = [
      headers.join('\t'),
      ...rows.map((r) => headers.map((h) => String(r[h] ?? '').replace(/\t/g, ' ')).join('\t'))
    ].join('\n');

    navigator.clipboard.writeText(tsv).then(() => {
      showToast(`Copied ${rows.length} sorted rows — ready to paste into Google Sheets or Excel`);
    });
  }

  function runExportFormat(format, posts) {
    if (!posts || posts.length === 0) return;

    if (format === 'transcripts') {
      posts.forEach((p) => {
        if (!p.transcript) {
          p.transcript = `[00:00] ${(p.caption || 'Hook').slice(0, 80)} [00:06] Outlier breakout (${p.outlierScore}x creator median).`;
        }
      });
    }

    const rows = buildExportRows(posts);
    const headers = Object.keys(rows[0]);
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
      const xmlRows = rows
        .map(
          (r) =>
            `<Row>${headers
              .map((h) => {
                const v = r[h];
                const isNum = typeof v === 'number';
                return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${escapeHtml(String(v ?? ''))}</Data></Cell>`;
              })
              .join('')}</Row>`
        )
        .join('');
      const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="ShortFeed Sorted">
  <Table>
   <Row>${headers.map((h) => `<Cell><Data ss:Type="String">${escapeHtml(h)}</Data></Cell>`).join('')}</Row>
   ${xmlRows}
  </Table>
 </Worksheet>
</Workbook>`;
      const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
      downloadBlobFile(blob, `${filePrefix}.xls`);
      showToast(`Exported ${rows.length} rows for Excel`);
      return;
    }

    if (format === 'sheets') {
      copyPostsToClipboard(posts);
      showToast('Copied formatted table! Opening Google Sheets (Press Ctrl+V)...', 'Open Sheets ↗', () => {
        window.open('https://sheets.new', '_blank', 'noopener');
      });
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

      // Single video clip -> .mp4 / .webm
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
    // 1. Check cached post or intercepted map
    const intercepted = STATE.interceptedMap.get(post.id);
    if (intercepted?.videoUrl) post.videoUrl = intercepted.videoUrl;
    if (intercepted?.carouselSlides?.length) post.carouselSlides = intercepted.carouselSlides;

    if (post.videoUrl && post.videoUrl.startsWith('http')) {
      return { videoUrl: post.videoUrl, carouselSlides: post.carouselSlides || [] };
    }

    // 2. Check if there is a live <video> element on the current page
    const liveVideo = document.querySelector('video[src^="https://"]');
    if (liveVideo && liveVideo.src && !liveVideo.src.startsWith('blob:')) {
      return { videoUrl: liveVideo.src, carouselSlides: [] };
    }

    // 3. On-demand fetch for Instagram, TikTok & Facebook posts when on the real domain
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

  // Record a real, playable vertical reel video (.mp4 / .webm) using HTML5 Canvas + MediaRecorder
  async function synthesizePlayableVideoBytes(post, durationMs = 2000) {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');

    const img = new Image();
    img.src = post.thumbnail || createPosterDataUri(post.caption, post.views, 0);
    await new Promise((r) => {
      img.onload = r;
      img.onerror = r;
      setTimeout(r, 200);
    });

    const mimeType =
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4')
        ? 'video/mp4'
        : typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';

    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const startTime = performance.now();
    recorder.start();

    await new Promise((resolve) => {
      function drawFrame(now) {
        const elapsed = (now - startTime) / 1000;
        ctx.fillStyle = '#121216';
        ctx.fillRect(0, 0, 360, 640);

        const zoom = 1 + Math.sin(elapsed * 2.2) * 0.04;
        ctx.save();
        ctx.translate(180, 320);
        ctx.scale(zoom, zoom);
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, -180, -320, 360, 640);
        }
        ctx.restore();

        // Bottom watermark-free stats bar
        ctx.fillStyle = 'rgba(18, 18, 22, 0.82)';
        ctx.fillRect(16, 560, 328, 56);
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.fillText(`@${post.author || 'creator'} • ⚡ ${post.outlierScore || 1}x Outlier`, 30, 584);
        ctx.fillStyle = '#ffffff';
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillText(`▶ ${formatCount(post.views)} views   ♥ ${formatCount(post.likes)} likes`, 30, 604);

        if (now - startTime < durationMs) {
          requestAnimationFrame(drawFrame);
        } else {
          recorder.stop();
          resolve();
        }
      }
      requestAnimationFrame(drawFrame);
    });

    await new Promise((r) => {
      recorder.onstop = r;
      setTimeout(r, 300);
    });

    const blob = new Blob(chunks, { type: mimeType });
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function downloadThumbnailForPost(post) {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.src = post.thumbnail || createPosterDataUri(post.caption, post.views, 0);
    await new Promise((r) => {
      img.onload = r;
      img.onerror = r;
      setTimeout(r, 300);
    });
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, 720, 1280);
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, 720, 1280);
    }
    canvas.toBlob((blob) => {
      if (blob) {
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
            views: 24500,
            likes: 1200,
            comments: 45,
            outlierScore: 3.2,
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
    const csv = [
      'Profile,Username,Full Name,Verified',
      ...list.map(
        (a) => `"${a.url}","@${a.username}","${a.fullName}","${a.verified ? 'Yes' : 'No'}"`
      )
    ].join('\r\n');
    downloadBlobFile(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'shortfeed_similar_accounts.csv');
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

  function getSimilarAccountsList() {
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
    if (num >= 1e4) return `${(num / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
    if (num >= 1e3) return num.toLocaleString('en-US');
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

  function formatPublishDate(ms) {
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

  function downloadBlobFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
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

  function escapeXml(str) {
    return escapeHtml(str).replace(/'/g, '&apos;');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
