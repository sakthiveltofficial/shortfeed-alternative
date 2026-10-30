// ShortFeed Page-Context Network & GraphQL Interceptor (MAIN world)
// Passively extracts rich post metrics (views, likes, comments, shares, saves, videoUrl, timestamps)
// and decodes Instagram shortcode IDs into exact publish dates.

(function () {
  if (window.__SHORTFEED_INTERCEPTOR_ACTIVE__) return;
  window.__SHORTFEED_INTERCEPTOR_ACTIVE__ = true;

  const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // Derive publish timestamp from Instagram shortcode or numeric media PK
  function decodeInstagramTimestamp(shortcode, pk) {
    try {
      if (pk && /^\d{15,}$/.test(String(pk))) {
        const bigId = BigInt(String(pk));
        // Instagram Snowflake-style IDs (epoch offset 1314220021721 ms)
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

  function emitPosts(posts) {
    if (!Array.isArray(posts) || posts.length === 0) return;
    window.dispatchEvent(
      new CustomEvent('SF_INTERCEPTED_POSTS', {
        detail: posts
      })
    );
  }

  // Deep-scan JSON payloads for Instagram, TikTok, YouTube & Facebook post objects
  function extractPostsFromJson(data, visited = new Set(), depth = 0) {
    const found = [];
    if (!data || typeof data !== 'object' || depth > 14 || visited.has(data)) return found;
    visited.add(data);

    // 1. Instagram Media / Clips node
    const code = data.code || data.shortcode;
    if (
      code &&
      typeof code === 'string' &&
      code.length >= 6 &&
      code.length <= 15 &&
      (data.play_count !== undefined ||
        data.view_count !== undefined ||
        data.video_view_count !== undefined ||
        data.like_count !== undefined ||
        data.edge_media_preview_like !== undefined ||
        data.image_versions2 !== undefined ||
        data.display_url !== undefined)
    ) {
      const views =
        data.play_count ??
        data.ig_play_count ??
        data.view_count ??
        data.video_view_count ??
        0;
      const likes =
        data.like_count ??
        data.edge_media_preview_like?.count ??
        data.edge_liked_by?.count ??
        0;
      const comments =
        data.comment_count ??
        data.edge_media_to_comment?.count ??
        data.edge_media_preview_comment?.count ??
        0;
      const caption =
        data.caption?.text ??
        data.edge_media_to_caption?.edges?.[0]?.node?.text ??
        '';
      const thumb =
        data.image_versions2?.candidates?.[0]?.url ??
        data.display_url ??
        data.thumbnail_src ??
        '';
      const videoUrl =
        data.video_versions?.[0]?.url ??
        data.video_url ??
        '';
      const carouselSlides = Array.isArray(data.carousel_media || data.edge_sidecar_to_children?.edges)
        ? (data.carousel_media || data.edge_sidecar_to_children.edges.map((e) => e.node))
            .filter(Boolean)
            .map((slide, idx) => ({
              index: idx + 1,
              isVideo: Boolean(slide.video_versions?.[0]?.url || slide.video_url),
              url:
                slide.video_versions?.[0]?.url ||
                slide.video_url ||
                slide.image_versions2?.candidates?.[0]?.url ||
                slide.display_url ||
                ''
            }))
            .filter((s) => s.url)
        : [];
      const takenAt = data.taken_at || data.taken_at_timestamp;
      const timestampMs = takenAt
        ? Number(takenAt) * 1000
        : decodeInstagramTimestamp(code, data.pk || data.id);
      const isVideo = Boolean(videoUrl || views > 0 || data.media_type === 2 || data.is_video);
      const isCarousel = carouselSlides.length > 1 || data.media_type === 8;
      const username = data.user?.username || data.owner?.username || '';

      found.push({
        id: `ig_${code}`,
        shortcode: code,
        platform: 'instagram',
        type: isCarousel ? 'carousel' : isVideo ? 'reel' : 'post',
        url: `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${code}/`,
        thumbnail: thumb,
        videoUrl,
        carouselSlides,
        views: Number(views) || 0,
        likes: Number(likes) || 0,
        comments: Number(comments) || 0,
        shares: Number(data.reshare_count || 0),
        saves: 0,
        caption: String(caption || ''),
        author: username,
        publishedAt: timestampMs || Date.now()
      });
    }

    // 2. TikTok Video Item node
    if (
      data.id &&
      data.stats &&
      (data.stats.playCount !== undefined || data.stats.diggCount !== undefined) &&
      (data.video || data.desc !== undefined)
    ) {
      const authorHandle =
        typeof data.author === 'string'
          ? data.author
          : data.author?.uniqueId || '';
      found.push({
        id: `tt_${data.id}`,
        shortcode: String(data.id),
        platform: 'tiktok',
        type: 'video',
        url: authorHandle
          ? `https://www.tiktok.com/@${authorHandle}/video/${data.id}`
          : `https://www.tiktok.com/video/${data.id}`,
        thumbnail: data.video?.cover || data.video?.originCover || data.video?.dynamicCover || '',
        videoUrl: data.video?.playAddr || data.video?.downloadAddr || '',
        views: Number(data.stats.playCount || 0),
        likes: Number(data.stats.diggCount || 0),
        comments: Number(data.stats.commentCount || 0),
        shares: Number(data.stats.shareCount || 0),
        saves: Number(data.stats.collectCount || 0),
        caption: String(data.desc || ''),
        author: authorHandle,
        publishedAt: data.createTime ? Number(data.createTime) * 1000 : Date.now()
      });
    }

    // 3. Facebook Reel / Video node
    if (
      (data.playable_url_quality_hd || data.browser_native_hd_url || data.playable_url || data.browser_native_sd_url) &&
      (data.id || data.video_id)
    ) {
      const fbId = String(data.id || data.video_id);
      const fbVideoUrl =
        data.browser_native_hd_url ||
        data.playable_url_quality_hd ||
        data.browser_native_sd_url ||
        data.playable_url ||
        '';
      found.push({
        id: `fb_${fbId}`,
        shortcode: fbId,
        platform: 'facebook',
        type: 'reel',
        url: `https://www.facebook.com/reel/${fbId}`,
        thumbnail: data.preferred_thumbnail?.image?.uri || data.thumbnailImage?.uri || '',
        videoUrl: fbVideoUrl,
        views: Number(data.play_count || data.view_count || 0),
        likes: Number(data.reactors?.count || data.likers?.count || 0),
        comments: Number(data.total_comment_count || 0),
        shares: Number(data.share_count_reduced || 0),
        saves: 0,
        caption: String(data.message?.text || data.name || ''),
        author: data.owner?.name || '',
        publishedAt: data.publish_time ? Number(data.publish_time) * 1000 : Date.now()
      });
    }

    // 4. YouTube Video / ReelItemRenderer node
    if (data.videoRenderer || data.richItemRenderer?.content?.videoRenderer || data.shortsLockupViewModel) {
      const vr = data.videoRenderer || data.richItemRenderer?.content?.videoRenderer;
      if (vr && vr.videoId) {
        const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || '';
        const viewText = vr.viewCountText?.simpleText || vr.shortViewCountText?.simpleText || '0';
        const thumb = vr.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '';
        found.push({
          id: `yt_${vr.videoId}`,
          shortcode: vr.videoId,
          platform: 'youtube',
          type: 'video',
          url: `https://www.youtube.com/watch?v=${vr.videoId}`,
          thumbnail: thumb,
          videoUrl: '',
          views: parseAbbreviatedCount(viewText),
          likes: 0,
          comments: 0,
          shares: 0,
          saves: 0,
          caption: title,
          title,
          duration: vr.lengthText?.simpleText || '',
          publishedText: vr.publishedTimeText?.simpleText || '',
          publishedAt: Date.now()
        });
      }
    }

    if (Array.isArray(data)) {
      for (let i = 0; i < Math.min(data.length, 250); i++) {
        found.push(...extractPostsFromJson(data[i], visited, depth + 1));
      }
    } else {
      const keys = Object.keys(data);
      for (let i = 0; i < Math.min(keys.length, 120); i++) {
        const k = keys[i];
        const val = data[k];
        if (val && typeof val === 'object') {
          found.push(...extractPostsFromJson(val, visited, depth + 1));
        }
      }
    }
    return found;
  }

  function parseAbbreviatedCount(raw) {
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

  // Hook window.fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);
    try {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') || '';
      if (contentType.includes('json') || contentType.includes('text/javascript')) {
        clone.json().then((json) => {
          const posts = extractPostsFromJson(json);
          if (posts.length > 0) emitPosts(posts);
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  // Hook XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__sfUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (!this.responseText || this.responseText.length < 20) return;
        if (this.responseText.startsWith('{') || this.responseText.startsWith('[')) {
          const json = JSON.parse(this.responseText);
          const posts = extractPostsFromJson(json);
          if (posts.length > 0) emitPosts(posts);
        }
      } catch {}
    });
    return origSend.apply(this, args);
  };
})();
