// ShortFeed Page-Context Network & GraphQL Interceptor (MAIN world)
// Passively extracts rich post metrics (views, likes, comments, shares, saves, videoUrl, timestamps)
// and decodes Instagram shortcode IDs into exact publish dates.

(function () {
  if (window.__SHORTFEED_INTERCEPTOR_ACTIVE__) return;
  window.__SHORTFEED_INTERCEPTOR_ACTIVE__ = true;

  const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let serverClockOffsetMs = 0;
  let hasServerClock = false;

  function updateServerClockFromHeader(dateHdr) {
    if (!dateHdr) return;
    const parsed = Date.parse(dateHdr);
    if (!isNaN(parsed) && parsed > 1500000000000) {
      hasServerClock = true;
      serverClockOffsetMs = parsed - Date.now();
      window.dispatchEvent(
        new CustomEvent('SF_SERVER_CLOCK', { detail: { offsetMs: serverClockOffsetMs } })
      );
    }
  }

  function getServerNow() {
    return Date.now() + serverClockOffsetMs;
  }

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

  // Decode Instagram shortcode to numeric media PK using IG_ALPHABET base64
  function shortcodeToMediaPk(shortcode) {
    try {
      if (!shortcode || typeof shortcode !== 'string') return '';
      let id = 0n;
      for (let i = 0; i < Math.min(shortcode.length, 11); i++) {
        const idx = IG_ALPHABET.indexOf(shortcode[i]);
        if (idx === -1) return '';
        id = id * 64n + BigInt(idx);
      }
      return id > 0n ? id.toString() : '';
    } catch {
      return '';
    }
  }

  function emitPosts(posts) {
    if (!Array.isArray(posts) || posts.length === 0) return;
    window.dispatchEvent(
      new CustomEvent('SF_INTERCEPTED_POSTS', {
        detail: posts
      })
    );
  }

  function emitSimilarAccounts(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) return;
    window.dispatchEvent(
      new CustomEvent('SF_INTERCEPTED_SIMILAR', {
        detail: accounts
      })
    );
  }

  function normalizeSimilarAccount(u) {
    if (!u || typeof u !== 'object') return null;
    const userObj = u.user && typeof u.user === 'object' ? u.user : u;
    const username = userObj.username;
    if (!username || typeof username !== 'string') return null;
    return {
      id: String(userObj.pk || userObj.id || username),
      username: String(username),
      fullName: String(userObj.full_name || username),
      verified: Boolean(userObj.is_verified),
      avatar: String(userObj.profile_pic_url || ''),
      category: String(userObj.category_name || userObj.social_context || u.social_context || ''),
      url: `https://www.instagram.com/${username}/`
    };
  }

  function extractSimilarAccountsFromJson(data, visited = new Set(), depth = 0, isChainingPayload = false) {
    const map = new Map();

    function walk(node, d, inChaining) {
      if (!node || typeof node !== 'object' || d > 28 || visited.has(node)) return;
      visited.add(node);

      const candidateLists = [];
      if (Array.isArray(node.edge_chaining?.edges)) {
        candidateLists.push(node.edge_chaining.edges.map((e) => e?.node).filter(Boolean));
      }
      if (node.xdt_api__v1__discover__chaining && typeof node.xdt_api__v1__discover__chaining === 'object') {
        if (Array.isArray(node.xdt_api__v1__discover__chaining.users)) {
          candidateLists.push(node.xdt_api__v1__discover__chaining.users);
        }
        if (Array.isArray(node.xdt_api__v1__discover__chaining.chaining_results)) {
          candidateLists.push(node.xdt_api__v1__discover__chaining.chaining_results);
        }
      }
      if (Array.isArray(node.chaining_results)) {
        candidateLists.push(node.chaining_results);
      }
      if (Array.isArray(node.chaining_suggestions)) {
        candidateLists.push(node.chaining_suggestions);
      }
      if (Array.isArray(node.suggested_users)) {
        candidateLists.push(node.suggested_users);
      } else if (node.suggested_users && typeof node.suggested_users === 'object') {
        if (Array.isArray(node.suggested_users.suggestions)) {
          candidateLists.push(node.suggested_users.suggestions);
        }
        if (Array.isArray(node.suggested_users.users)) {
          candidateLists.push(node.suggested_users.users);
        }
      }
      if (Array.isArray(node.users)) {
        const hasChainingContext =
          inChaining ||
          node.chaining_upsell_cards !== undefined ||
          node.has_more_chaining !== undefined ||
          node.is_eligible_for_chaining !== undefined ||
          node.users.some(
            (u) =>
              u &&
              typeof u === 'object' &&
              u.username &&
              u.full_name !== undefined &&
              u.is_verified !== undefined &&
              u.profile_pic_url
          );
        if (hasChainingContext) {
          candidateLists.push(node.users);
        }
      }
      if (
        inChaining &&
        node.username &&
        node.full_name !== undefined &&
        node.is_verified !== undefined &&
        node.profile_pic_url
      ) {
        candidateLists.push([node]);
      }

      candidateLists.forEach((arr) => {
        arr.forEach((raw) => {
          const norm = normalizeSimilarAccount(raw);
          if (norm && !map.has(norm.username.toLowerCase())) {
            map.set(norm.username.toLowerCase(), norm);
          }
        });
      });

      if (Array.isArray(node)) {
        for (let i = 0; i < Math.min(node.length, 250); i++) {
          walk(node[i], d + 1, inChaining);
        }
      } else {
        const keys = Object.keys(node);
        for (let i = 0; i < Math.min(keys.length, 200); i++) {
          const k = keys[i];
          const val = node[k];
          if (val && typeof val === 'object') {
            const keyIsChaining = inChaining || /chaining|suggested/i.test(k);
            walk(val, d + 1, keyIsChaining);
          }
        }
      }
    }

    walk(data, depth, isChainingPayload);
    return Array.from(map.values());
  }

  // Merge two post objects without overwriting non-zero metrics or non-empty strings with 0/empty
  function mergePostData(prev, next) {
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
    const stringKeys = ['thumbnail', 'videoUrl', 'caption', 'author', 'url', 'title', 'subtitleUrl', 'accessibilityCaption', 'duration', 'category', 'publishedText'];
    stringKeys.forEach((k) => {
      merged[k] = next[k] || prev[k] || '';
    });
    if (prev.type === 'reel' || next.type === 'reel') merged.type = 'reel';
    if ((prev.carouselSlides && prev.carouselSlides.length) && !(next.carouselSlides && next.carouselSlides.length)) {
      merged.carouselSlides = prev.carouselSlides;
    }
    return merged;
  }

  // Deep-scan JSON payloads for Instagram, TikTok, YouTube & Facebook post objects
  function extractPostsFromJson(data, visited = new Set(), depth = 0) {
    const found = [];
    if (!data || typeof data !== 'object' || depth > 40 || visited.has(data)) return found;
    visited.add(data);

    // Unwrap Instagram clips/reels wrapper if present: { media: { code: ..., play_count: ... } }
    if (data.media && typeof data.media === 'object' && (data.media.code || data.media.shortcode)) {
      found.push(...extractPostsFromJson(data.media, visited, depth + 1));
    }

    // 1. Instagram Media / Clips node
    const code = data.code || data.shortcode;
    if (
      code &&
      typeof code === 'string' &&
      code.length >= 6 &&
      code.length <= 15 &&
      (data.play_count !== undefined ||
        data.ig_play_count !== undefined ||
        data.fb_play_count !== undefined ||
        data.view_count !== undefined ||
        data.video_view_count !== undefined ||
        data.clips_metadata !== undefined ||
        data.like_count !== undefined ||
        data.edge_media_preview_like !== undefined ||
        data.image_versions2 !== undefined ||
        data.display_url !== undefined)
    ) {
      let views = Math.max(
        Number(data.play_count) || 0,
        Number(data.ig_play_count) || 0,
        Number(data.fb_play_count) || 0,
        Number(data.view_count) || 0,
        Number(data.video_view_count) || 0,
        Number(data.clips_metadata?.play_count) || 0,
        Number(data.clips_metadata?.ig_play_count) || 0
      );
      let carouselViews = 0;
      const rawSlides = data.carousel_media || data.edge_sidecar_to_children?.edges;
      if (Array.isArray(rawSlides)) {
        rawSlides.forEach((s) => {
          const node = s?.node || s;
          if (node) {
            const sv = Math.max(
              Number(node.play_count) || 0,
              Number(node.ig_play_count) || 0,
              Number(node.view_count) || 0,
              Number(node.video_view_count) || 0
            );
            if (sv > carouselViews) carouselViews = sv;
          }
        });
      }
      if (!views && carouselViews > 0) views = carouselViews;
      const likes = Math.max(
        Number(data.like_count) || 0,
        Number(data.fb_like_count) || 0,
        Number(data.edge_media_preview_like?.count) || 0,
        Number(data.edge_liked_by?.count) || 0
      );
      const comments = Math.max(
        Number(data.comment_count) || 0,
        Number(data.edge_media_to_comment?.count) || 0,
        Number(data.edge_media_preview_comment?.count) || 0
      );
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
      const isVideo = Boolean(
        videoUrl ||
          views > 0 ||
          data.media_type === 2 ||
          data.is_video ||
          data.product_type === 'clips' ||
          data.__typename === 'GraphVideo'
      );
      const isCarousel = carouselSlides.length > 1 || data.media_type === 8 || data.__typename === 'GraphSidecar';
      const username = data.user?.username || data.owner?.username || '';
      const rawPk = String(data.pk || data.id || '').split('_')[0];
      const subtitleUrl =
        data.video_subtitles_uri ||
        data.clips_metadata?.video_subtitles_uri ||
        '';
      const accessibilityCaption =
        data.accessibility_caption ||
        data.clips_metadata?.original_sound_info?.original_audio_title ||
        '';

      const igAgeDays =
        timestampMs && hasServerClock
          ? Math.max(0, Math.round(((getServerNow() - timestampMs) / 86400000) * 100) / 100)
          : null;

      found.push({
        id: `ig_${code}`,
        shortcode: code,
        mediaPk: /^\d+$/.test(rawPk) ? rawPk : '',
        platform: 'instagram',
        type: isCarousel ? 'carousel' : isVideo ? 'reel' : 'post',
        url: `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${code}/`,
        thumbnail: thumb,
        videoUrl,
        subtitleUrl: String(subtitleUrl || ''),
        accessibilityCaption: String(accessibilityCaption || ''),
        carouselSlides,
        views: Number(views) || 0,
        likes: Number(likes) || 0,
        comments: Number(comments) || 0,
        shares: maxCount(
          data.reshare_count,
          data.share_count,
          data.media_repost_count,
          data.repost_count,
          data.clips_metadata?.reshare_count,
          data.clips_metadata?.share_count
        ),
        saves: maxCount(data.save_count, data.saved_count),
        caption: String(caption || ''),
        author: username,
        publishedAt: timestampMs || 0,
        relativeAgeDays: igAgeDays,
        hasExactTimestamp: Boolean(timestampMs)
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
      const claCaptions = data.video?.claInfo?.captionInfos || data.video?.subtitleInfos || [];
      const ttSubtitleUrl = Array.isArray(claCaptions)
        ? (claCaptions[0]?.url || claCaptions[0]?.Url || '')
        : '';
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
        subtitleUrl: String(ttSubtitleUrl || ''),
        accessibilityCaption: '',
        views: maxCount(data.stats.playCount, data.statsV2?.playCount),
        likes: maxCount(data.stats.diggCount, data.statsV2?.diggCount),
        comments: maxCount(data.stats.commentCount, data.statsV2?.commentCount),
        shares: maxCount(data.stats.shareCount, data.statsV2?.shareCount, data.statsV2?.repostCount),
        saves: maxCount(data.stats.collectCount, data.statsV2?.collectCount),
        caption: String(data.desc || ''),
        author: authorHandle,
        publishedAt: data.createTime ? Number(data.createTime) * 1000 : Date.now(),
        hasExactTimestamp: Boolean(data.createTime)
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
        subtitleUrl: String(data.video_captions_url || data.captions_url || ''),
        accessibilityCaption: String(data.accessibility_caption || ''),
        views: maxCount(
          data.play_count,
          data.video_view_count,
          data.view_count,
          data.play_count_reduced,
          data.feedback?.video_view_count
        ),
        likes: maxCount(
          data.reactors?.count,
          data.likers?.count,
          data.feedback?.reaction_count?.count,
          data.feedback?.unified_reactors?.count,
          data.unified_reactors?.count
        ),
        comments: maxCount(
          data.total_comment_count,
          data.comment_count,
          data.feedback?.comment_count?.total_count,
          data.feedback?.total_comment_count,
          data.comments?.total_count
        ),
        shares: maxCount(
          data.share_count_reduced,
          data.share_count,
          data.reshare_count,
          data.feedback?.share_count?.count,
          data.feedback?.share_count_reduced,
          data.feedback?.reshares?.count
        ),
        saves: 0,
        caption: String(data.message?.text || data.name || ''),
        author: data.owner?.name || '',
        publishedAt: data.publish_time ? Number(data.publish_time) * 1000 : Date.now()
      });
    }

    // 4. YouTube Video / Shorts / Lockup Renderer nodes
    const vr =
      data.videoRenderer ||
      data.gridVideoRenderer ||
      data.compactVideoRenderer ||
      data.playlistVideoRenderer;
    if (vr && vr.videoId) {
      const title = extractYtText(vr.title);
      const viewText = extractYtText(vr.viewCountText) || extractYtText(vr.shortViewCountText) || '0';
      const publishedText = extractYtText(vr.publishedTimeText);
      const relTs = parseRelativeTimeToMs(publishedText);
      const relDays = parseRelativeAgeDays(publishedText);
      const thumb = vr.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`;
      const isShort = Boolean(
        vr.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url?.includes('/shorts/')
      );
      found.push({
        id: `yt_${vr.videoId}`,
        shortcode: vr.videoId,
        platform: 'youtube',
        type: isShort ? 'short' : 'video',
        url: isShort
          ? `https://www.youtube.com/shorts/${vr.videoId}`
          : `https://www.youtube.com/watch?v=${vr.videoId}`,
        thumbnail: thumb,
        videoUrl: '',
        views: parseAbbreviatedCount(viewText),
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        caption: title,
        title,
        author: extractYtText(vr.ownerText || vr.shortBylineText || vr.longBylineText),
        duration: extractYtText(vr.lengthText),
        publishedText,
        publishedAt: relTs || 0,
        relativeAgeDays: relDays,
        hasExactTimestamp: false
      });
    }

    const sl = data.shortsLockupViewModel;
    if (sl) {
      const slVid =
        sl.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ||
        sl.inlinePlayerData?.onVisible?.innertubeCommand?.reelWatchEndpoint?.videoId ||
        String(sl.entityId || '').replace(/^shorts-shelf-item-/, '').trim();
      if (/^[A-Za-z0-9_-]{11}$/.test(slVid)) {
        const title =
          sl.overlayMetadata?.primaryText?.content ||
          String(sl.accessibilityText || '').split(/,\s*[\d.,]+\s*[KMBkmb]?\s*views/i)[0] ||
          '';
        const viewText = sl.overlayMetadata?.secondaryText?.content || sl.accessibilityText || '0';
        const thumb =
          sl.thumbnail?.sources?.slice(-1)?.[0]?.url ||
          sl.thumbnailViewModel?.thumbnailViewModel?.image?.sources?.slice(-1)?.[0]?.url ||
          `https://i.ytimg.com/vi/${slVid}/hqdefault.jpg`;
        found.push({
          id: `yt_${slVid}`,
          shortcode: slVid,
          platform: 'youtube',
          type: 'short',
          url: `https://www.youtube.com/shorts/${slVid}`,
          thumbnail: thumb,
          videoUrl: '',
          views: parseAbbreviatedCount(viewText),
          likes: 0,
          comments: 0,
          shares: 0,
          saves: 0,
          caption: title,
          title,
          duration: '0:45',
          publishedText: '',
          publishedAt: 0,
          hasExactTimestamp: false
        });
      }
    }

    const ri = data.reelItemRenderer;
    if (ri && ri.videoId) {
      const title = extractYtText(ri.headline) || extractYtText(ri.accessibility?.accessibilityData?.label);
      const viewText = extractYtText(ri.viewCountText) || '0';
      const thumb = ri.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || `https://i.ytimg.com/vi/${ri.videoId}/hqdefault.jpg`;
      found.push({
        id: `yt_${ri.videoId}`,
        shortcode: ri.videoId,
        platform: 'youtube',
        type: 'short',
        url: `https://www.youtube.com/shorts/${ri.videoId}`,
        thumbnail: thumb,
        videoUrl: '',
        views: parseAbbreviatedCount(viewText),
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        caption: title,
        title,
        duration: '0:45',
        publishedText: '',
        publishedAt: 0,
        hasExactTimestamp: false
      });
    }

    const lvm = data.lockupViewModel;
    if (lvm && /^[A-Za-z0-9_-]{11}$/.test(String(lvm.contentId || ''))) {
      const lVid = String(lvm.contentId);
      const metaVm = lvm.metadata?.lockupMetadataViewModel || {};
      const title = metaVm.title?.content || '';
      const rows = metaVm.metadata?.contentMetadataViewModel?.metadataRows || [];
      let viewText = '';
      let publishedText = '';
      let author = '';
      if (Array.isArray(rows)) {
        rows.forEach((row) => {
          const parts = Array.isArray(row?.metadataParts) ? row.metadataParts : [];
          parts.forEach((part) => {
            const txt = String(part?.text?.content || '').trim();
            if (!txt) return;
            if (/views?/i.test(txt) && !viewText) {
              viewText = txt;
            } else if (/ago$/i.test(txt) && !publishedText) {
              publishedText = txt;
            } else if (!author && !/views?|ago$/i.test(txt)) {
              author = txt;
            }
          });
        });
      }
      const relTs = parseRelativeTimeToMs(publishedText);
      const relDays = parseRelativeAgeDays(publishedText);
      const thumb =
        lvm.contentImage?.thumbnailViewModel?.image?.sources?.slice(-1)?.[0]?.url ||
        `https://i.ytimg.com/vi/${lVid}/hqdefault.jpg`;
      const isShort =
        String(lvm.contentType || '').includes('SHORT') ||
        Boolean(lvm.rendererContext?.commandContext?.onTap?.innertubeCommand?.reelWatchEndpoint);
      const overlays = lvm.contentImage?.thumbnailViewModel?.overlays || [];
      let duration = '';
      for (let i = 0; i < overlays.length; i++) {
        const badgeText =
          overlays[i]?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text ||
          overlays[i]?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text ||
          '';
        if (/^\d{1,2}:\d{2}/.test(badgeText)) {
          duration = badgeText;
          break;
        }
      }
      found.push({
        id: `yt_${lVid}`,
        shortcode: lVid,
        platform: 'youtube',
        type: isShort ? 'short' : 'video',
        url: isShort
          ? `https://www.youtube.com/shorts/${lVid}`
          : `https://www.youtube.com/watch?v=${lVid}`,
        thumbnail: thumb,
        videoUrl: '',
        views: parseAbbreviatedCount(viewText),
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        caption: title,
        title,
        author,
        duration,
        publishedText,
        publishedAt: relTs || 0,
        relativeAgeDays: relDays,
        hasExactTimestamp: false
      });
    }

    if (Array.isArray(data)) {
      for (let i = 0; i < Math.min(data.length, 300); i++) {
        found.push(...extractPostsFromJson(data[i], visited, depth + 1));
      }
    } else {
      const keys = Object.keys(data);
      for (let i = 0; i < Math.min(keys.length, 250); i++) {
        const k = keys[i];
        const val = data[k];
        if (val && typeof val === 'object') {
          found.push(...extractPostsFromJson(val, visited, depth + 1));
        } else if (
          typeof val === 'string' &&
          val.length > 40 &&
          (val.startsWith('{') || val.startsWith('[')) &&
          (val.includes('"code"') ||
            val.includes('"shortcode"') ||
            val.includes('"play_count"') ||
            val.includes('"videoRenderer"') ||
            val.includes('"shortsLockupViewModel"') ||
            val.includes('"lockupViewModel"'))
        ) {
          try {
            found.push(...extractPostsFromJson(JSON.parse(val), visited, depth + 1));
          } catch {}
        }
      }
    }
    return found;
  }

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  // Normalize any count shape: number, "1234", "1.2K", "1,234", { count }, { total_count }
  function toCount(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') return parseAbbreviatedCount(v);
    if (typeof v === 'object') {
      return toCount(v.count ?? v.total_count ?? v.value ?? null);
    }
    return 0;
  }

  function maxCount(...vals) {
    return vals.reduce((m, v) => Math.max(m, toCount(v)), 0);
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

  function extractYtText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (typeof node.content === 'string') return node.content;
    if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
    if (node.accessibility?.accessibilityData?.label) return node.accessibility.accessibilityData.label;
    return '';
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
    return mult ? Math.round(getServerNow() - n * mult) : null;
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

  function formatDurationSec(totalSeconds) {
    const sec = Math.max(0, Math.round(Number(totalSeconds) || 0));
    if (!sec) return '';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const rem = sec % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    }
    return `${mins}:${String(rem).padStart(2, '0')}`;
  }

  function extractYtNextEngagement(nextJson) {
    let likes = 0;
    let comments = 0;
    const visited = new Set();

    function walk(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 30 || visited.has(node)) return;
      visited.add(node);

      if (node.segmentedLikeDislikeButtonViewModel) {
        const btnVm =
          node.segmentedLikeDislikeButtonViewModel.likeButtonViewModel?.likeButtonViewModel
            ?.toggleButtonViewModel?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel;
        if (btnVm) {
          const acc = String(btnVm.accessibilityText || '');
          const accMatch = acc.match(/with\s+([\d.,]+\s*[KMBkmb]?)\s+other/i) || acc.match(/([\d.,]+\s*[KMBkmb]?)\s+likes?/i);
          likes = Math.max(likes, parseAbbreviatedCount(accMatch ? accMatch[1] : btnVm.title || '0'));
        }
      }

      if (node.likeButtonViewModel && !node.segmentedLikeDislikeButtonViewModel) {
        const btnVm =
          node.likeButtonViewModel.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel
            ?.defaultButtonViewModel?.buttonViewModel || node.likeButtonViewModel;
        const acc = String(btnVm?.accessibilityText || '');
        const accMatch = acc.match(/([\d.,]+\s*[KMBkmb]?)/);
        likes = Math.max(likes, parseAbbreviatedCount(btnVm?.title || (accMatch ? accMatch[1] : '0')));
      }

      if (node.toggleButtonRenderer?.accessibilityData?.accessibilityData?.label || node.toggleButtonRenderer?.defaultText) {
        const lbl = String(node.toggleButtonRenderer.accessibilityData?.accessibilityData?.label || '');
        if (/\blike\b/i.test(lbl)) {
          const m = lbl.match(/([\d.,]+\s*[KMBkmb]?)/);
          const txt = extractYtText(node.toggleButtonRenderer.defaultText);
          likes = Math.max(likes, parseAbbreviatedCount(m ? m[1] : txt));
        }
      }

      if (
        node.targetId === 'engagement-panel-comments-section' ||
        node.panelIdentifier === 'engagement-panel-comments-section'
      ) {
        const ctxText = extractYtText(node.header?.engagementPanelTitleHeaderRenderer?.contextualInfo);
        if (ctxText) comments = Math.max(comments, parseAbbreviatedCount(ctxText));
      }

      if (node.commentsEntryPointHeaderRenderer) {
        const cText = extractYtText(node.commentsEntryPointHeaderRenderer.commentCount);
        if (cText) comments = Math.max(comments, parseAbbreviatedCount(cText));
      }

      if (node.commentCount !== undefined && typeof node.commentCount !== 'boolean') {
        comments = Math.max(comments, toCount(node.commentCount) || parseAbbreviatedCount(extractYtText(node.commentCount)));
      }

      if (Array.isArray(node)) {
        for (let i = 0; i < Math.min(node.length, 150); i++) {
          walk(node[i], depth + 1);
        }
      } else {
        const keys = Object.keys(node);
        for (let i = 0; i < Math.min(keys.length, 150); i++) {
          const val = node[keys[i]];
          if (val && typeof val === 'object') walk(val, depth + 1);
        }
      }
    }

    walk(nextJson, 0);
    return { likes, comments };
  }

  // Hook window.fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const response = await origFetch.apply(this, args);
    try {
      if (!hasServerClock && response.type === 'basic') {
        updateServerClockFromHeader(response.headers?.get?.('date'));
      }
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') || '';
      if (contentType.includes('json') || contentType.includes('text/javascript')) {
        const isChainingUrl = /chaining|suggested/i.test(reqUrl);
        clone.json().then((json) => {
          const posts = extractPostsFromJson(json);
          if (posts.length > 0) emitPosts(posts);
          const similar = extractSimilarAccountsFromJson(json, new Set(), 0, isChainingUrl);
          if (similar.length > 0) emitSimilarAccounts(similar);
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
        if (!hasServerClock && this.responseURL && this.responseURL.startsWith(location.origin)) {
          const allHeaders = this.getAllResponseHeaders?.() || '';
          const dateMatch = allHeaders.match(/^date:\s*(.+)$/im);
          if (dateMatch && dateMatch[1]) {
            updateServerClockFromHeader(dateMatch[1].trim());
          }
        }
        if (this.responseType && this.responseType !== 'text') return;
        if (!this.responseText || this.responseText.length < 20) return;
        const cleanText = this.responseText.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, '').trim();
        if (cleanText.startsWith('{') || cleanText.startsWith('[')) {
          const json = JSON.parse(cleanText);
          const posts = extractPostsFromJson(json);
          if (posts.length > 0) emitPosts(posts);
          const isChainingUrl = /chaining|suggested/i.test(String(this.__sfUrl || ''));
          const similar = extractSimilarAccountsFromJson(json, new Set(), 0, isChainingUrl);
          if (similar.length > 0) emitSimilarAccounts(similar);
        }
      } catch {}
    });
    return origSend.apply(this, args);
  };

  // Scan SSR embedded JSON scripts (<script type="application/json"> & YouTube window globals)
  function scanEmbeddedJsonScripts() {
    try {
      const scripts = document.querySelectorAll('script[type="application/json"], script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      scripts.forEach((s) => {
        if (s.__sfScanned) return;
        s.__sfScanned = true;
        const raw = s.textContent || '';
        if (raw.length < 40) return;
        try {
          const json = JSON.parse(raw);
          const posts = extractPostsFromJson(json);
          if (posts.length > 0) emitPosts(posts);
          const similar = extractSimilarAccountsFromJson(json);
          if (similar.length > 0) emitSimilarAccounts(similar);
        } catch {}
      });

      if (window.ytInitialData && typeof window.ytInitialData === 'object') {
        const ytPosts = extractPostsFromJson(window.ytInitialData);
        if (ytPosts.length > 0) emitPosts(ytPosts);
      }
      if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
        const vd = window.ytInitialPlayerResponse.videoDetails;
        const mf = window.ytInitialPlayerResponse.microformat?.playerMicroformatRenderer;
        if (vd?.videoId) {
          const pubStr = mf?.publishDate || mf?.uploadDate || '';
          const pubMs = pubStr ? Date.parse(pubStr) : NaN;
          const captionTracks = window.ytInitialPlayerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          const track = captionTracks.find((t) => /^en/i.test(t.languageCode || '')) || captionTracks[0];
          emitPosts([{
            id: `yt_${vd.videoId}`,
            shortcode: vd.videoId,
            platform: 'youtube',
            type: 'video',
            url: `https://www.youtube.com/watch?v=${vd.videoId}`,
            thumbnail: vd.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || `https://i.ytimg.com/vi/${vd.videoId}/hqdefault.jpg`,
            videoUrl: window.ytInitialPlayerResponse.streamingData?.formats?.find((f) => f.url)?.url || '',
            subtitleUrl: track?.baseUrl || '',
            views: Number(vd.viewCount) || 0,
            likes: Number(mf?.likeCount) || 0,
            comments: 0,
            shares: 0,
            saves: 0,
            title: String(vd.title || ''),
            caption: String(vd.shortDescription || vd.title || ''),
            author: String(vd.author || ''),
            duration: formatDurationSec(vd.lengthSeconds),
            category: String(mf?.category || ''),
            publishedText: pubStr,
            publishedAt: !isNaN(pubMs) && pubMs > 0 ? pubMs : 0,
            hasExactTimestamp: !isNaN(pubMs) && pubMs > 0
          }]);
        }
      }
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanEmbeddedJsonScripts);
  } else {
    scanEmbeddedJsonScripts();
  }
  setTimeout(scanEmbeddedJsonScripts, 1500);
  window.addEventListener('SF_REQUEST_RESCAN', scanEmbeddedJsonScripts);

  let stopIgCollection = false;
  window.addEventListener('SF_STOP_COLLECTION', () => {
    stopIgCollection = true;
  });

  // Actively fetch creator Reels (with play_count) & Web Profile Info from MAIN world when requested
  window.addEventListener('SF_FETCH_IG_PROFILE_REELS', async (e) => {
    stopIgCollection = false;
    const username = e.detail?.username;
    const shortcodes = Array.isArray(e.detail?.shortcodes) ? e.detail.shortcodes : [];
    const targetLimit = Number(e.detail?.targetLimit) || 50;
    const filterDays = Number(e.detail?.filterDays) || 0;
    const targetMinAgeDays = filterDays > 0 ? Math.max(1, filterDays * 0.7) : 0;

    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const fetchWithBackoff = async (url, opts) => {
      const res = await origFetch(url, opts);
      if (res.status === 429 && !stopIgCollection) {
        await sleepMs(2500);
        return await origFetch(url, opts);
      }
      return res;
    };

    try {
      scanEmbeddedJsonScripts();
      const csrf = getCsrfToken();
      const headers = {
        'x-ig-app-id': '936619743392459',
        'x-requested-with': 'XMLHttpRequest',
        ...(csrf ? { 'x-csrftoken': csrf } : {})
      };

      if (username) {
        const profRes = await fetchWithBackoff(
          `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
          { credentials: 'include', headers }
        );
        updateServerClockFromHeader(profRes.headers?.get?.('date'));
        if (profRes.ok) {
          const profJson = await profRes.json();
          const profPosts = extractPostsFromJson(profJson);
          if (profPosts.length > 0) emitPosts(profPosts);
          const profSimilar = extractSimilarAccountsFromJson(profJson);
          if (profSimilar.length > 0) emitSimilarAccounts(profSimilar);

          const userId = profJson?.data?.user?.id || profJson?.data?.user?.pk;
          if (userId) {
            // Fire chaining request asynchronously so feed pagination starts immediately
            origFetch(
              `https://www.instagram.com/api/v1/discover/chaining/?target_id=${encodeURIComponent(userId)}`,
              { credentials: 'include', headers }
            )
              .then((chainRes) => (chainRes.ok ? chainRes.json() : null))
              .then((chainJson) => {
                if (!chainJson) return;
                const chainSimilar = extractSimilarAccountsFromJson(chainJson);
                if (chainSimilar.length > 0) emitSimilarAccounts(chainSimilar);
              })
              .catch(() => {});

            // On Profile Posts tab, paginate user feed with adaptive throttling (unlimited/high cap for All)
            if (!e.detail?.includeClipsOnly) {
              let feedMaxId = '';
              const feedPages = filterDays > 0 ? 15 : Math.min(3000, Math.max(4, Math.ceil(targetLimit / 30)));
              let olderFeedCount = 0;
              let oldestFeedAge = 0;
              for (let page = 0; page < feedPages; page++) {
                if (stopIgCollection) break;
                if (page >= 45) await sleepMs(280);
                else if (page >= 15) await sleepMs(150);
                try {
                  const feedUrl = feedMaxId
                    ? `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/?count=33&max_id=${encodeURIComponent(feedMaxId)}`
                    : `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/?count=33`;
                  const feedRes = await fetchWithBackoff(feedUrl, { credentials: 'include', headers });
                  if (!feedRes.ok) break;
                  updateServerClockFromHeader(feedRes.headers?.get?.('date'));
                  const feedJson = await feedRes.json();
                  const feedPosts = extractPostsFromJson(feedJson);
                  if (feedPosts.length > 0) {
                    emitPosts(feedPosts);
                    if (filterDays > 0) {
                      feedPosts.forEach((fp) => {
                        const age = typeof fp.relativeAgeDays === 'number' ? fp.relativeAgeDays : null;
                        if (age !== null) {
                          if (age >= targetMinAgeDays) olderFeedCount++;
                          if (age > oldestFeedAge) oldestFeedAge = age;
                        }
                      });
                      if (olderFeedCount >= 15 && oldestFeedAge > filterDays * 1.4) break;
                    }
                  }

                  const nextCursor = feedJson?.next_max_id;
                  if (!feedJson?.more_available || !nextCursor || String(nextCursor) === feedMaxId) break;
                  feedMaxId = String(nextCursor);
                } catch {
                  break;
                }
              }
            }

            // Paginate creator's Reels/Clips feed with adaptive throttling
            let maxId = '';
            const maxPages = e.detail?.includeClipsOnly
              ? filterDays > 0
                ? 15
                : Math.min(4000, Math.max(3, Math.ceil(targetLimit / 12) + 1))
              : 1;
            let olderClipCount = 0;
            let oldestClipAge = 0;
            for (let page = 0; page < maxPages; page++) {
              if (stopIgCollection) break;
              if (page >= 45) await sleepMs(280);
              else if (page >= 15) await sleepMs(150);
              const params = {
                target_user_id: String(userId),
                page_size: '50',
                include_feed_video: 'true'
              };
              if (maxId) params.max_id = maxId;

              const clipsRes = await fetchWithBackoff('https://www.instagram.com/api/v1/clips/user/', {
                method: 'POST',
                credentials: 'include',
                headers: {
                  ...headers,
                  'content-type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(params).toString()
              });
              if (!clipsRes.ok) break;
              updateServerClockFromHeader(clipsRes.headers?.get?.('date'));
              const clipsJson = await clipsRes.json();
              const clipsPosts = extractPostsFromJson(clipsJson);
              if (clipsPosts.length > 0) {
                emitPosts(clipsPosts);
                if (filterDays > 0 && e.detail?.includeClipsOnly) {
                  clipsPosts.forEach((cp) => {
                    const age = typeof cp.relativeAgeDays === 'number' ? cp.relativeAgeDays : null;
                    if (age !== null) {
                      if (age >= targetMinAgeDays) olderClipCount++;
                      if (age > oldestClipAge) oldestClipAge = age;
                    }
                  });
                  if (olderClipCount >= 15 && oldestClipAge > filterDays * 1.4) break;
                }
              }

              const nextCursor = clipsJson?.paging_info?.max_id;
              const moreAvailable = clipsJson?.paging_info?.more_available;
              if (!moreAvailable || !nextCursor || nextCursor === maxId) break;
              maxId = String(nextCursor);
            }
          }
        }
      }

      // If specific shortcodes still need view counts, query Instagram's v1 media info API by numeric PK
      if (shortcodes.length > 0) {
        const batch = shortcodes.slice(0, 25);
        await Promise.all(
          batch.map(async (item) => {
            const code = typeof item === 'string' ? item : item?.shortcode;
            const pk = (typeof item === 'object' && item?.mediaPk) || shortcodeToMediaPk(code);
            if (!code) return;
            try {
              if (pk) {
                const infoRes = await origFetch(
                  `https://www.instagram.com/api/v1/media/${encodeURIComponent(pk)}/info/`,
                  { credentials: 'include', headers }
                );
                if (infoRes.ok) {
                  const infoJson = await infoRes.json();
                  const infoPosts = extractPostsFromJson(infoJson);
                  if (infoPosts.length > 0) {
                    emitPosts(infoPosts);
                    return;
                  }
                }
              }
              const r = await origFetch(
                `https://www.instagram.com/p/${encodeURIComponent(code)}/?__a=1&__d=dis`,
                { credentials: 'include', headers }
              );
              if (r.ok) {
                const j = await r.json();
                const p = extractPostsFromJson(j);
                if (p.length > 0) emitPosts(p);
              }
            } catch {}
          })
        );
      }
    } catch {}
    window.dispatchEvent(new CustomEvent('SF_FETCH_IG_COMPLETE'));
  });

  // Dedicated on-demand Similar Accounts fetcher when user opens the Similar drawer
  window.addEventListener('SF_FETCH_IG_SIMILAR', async (e) => {
    const username = e.detail?.username;
    try {
      scanEmbeddedJsonScripts();
      if (username) {
        const csrf = getCsrfToken();
        const headers = {
          'x-ig-app-id': '936619743392459',
          'x-requested-with': 'XMLHttpRequest',
          ...(csrf ? { 'x-csrftoken': csrf } : {})
        };
        const profRes = await origFetch(
          `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
          { credentials: 'include', headers }
        );
        updateServerClockFromHeader(profRes.headers?.get?.('date'));
        if (profRes.ok) {
          const profJson = await profRes.json();
          const profSimilar = extractSimilarAccountsFromJson(profJson);
          if (profSimilar.length > 0) emitSimilarAccounts(profSimilar);

          const userId = profJson?.data?.user?.id || profJson?.data?.user?.pk;
          if (userId) {
            const chainRes = await origFetch(
              `https://www.instagram.com/api/v1/discover/chaining/?target_id=${encodeURIComponent(userId)}`,
              { credentials: 'include', headers }
            );
            if (chainRes.ok) {
              const chainJson = await chainRes.json();
              const chainSimilar = extractSimilarAccountsFromJson(chainJson);
              if (chainSimilar.length > 0) emitSimilarAccounts(chainSimilar);
            }
          }
        }
      }
    } catch {}
    window.dispatchEvent(new CustomEvent('SF_FETCH_IG_SIMILAR_COMPLETE'));
  });

  // Extract a direct playable MP4 URL (unencrypted) from a YouTube /player payload
  function extractDirectYtUrl(pJson, allowAdaptive = false) {
    if (!pJson || typeof pJson !== 'object') return '';
    const getFormatUrl = (f) => {
      if (f?.url) return f.url;
      const rawCipher = f?.signatureCipher || f?.cipher;
      if (rawCipher && typeof rawCipher === 'string') {
        try {
          const params = new URLSearchParams(rawCipher);
          if (!params.get('s') && params.get('url')) return params.get('url');
        } catch {}
      }
      return '';
    };
    const fmts = pJson?.streamingData?.formats || [];
    const preferredProg = fmts.find((f) => (f?.itag === 22 || f?.itag === 18) && getFormatUrl(f));
    if (preferredProg) return getFormatUrl(preferredProg);
    const progMp4 = fmts.find((f) => /mp4/i.test(f?.mimeType || '') && getFormatUrl(f));
    if (progMp4) return getFormatUrl(progMp4);
    const anyProg = fmts.find((f) => Boolean(getFormatUrl(f)));
    if (anyProg) return getFormatUrl(anyProg);
    if (!allowAdaptive) return '';
    const adaptive = pJson?.streamingData?.adaptiveFormats || [];
    const adapMp4 = adaptive.find((f) => /video\/mp4/i.test(f?.mimeType || '') && getFormatUrl(f));
    return adapMp4 ? getFormatUrl(adapMp4) : '';
  }

  // Resolve a direct YouTube stream URL using existing player JSON first, then ANDROID_VR & IOS clients
  async function fetchPlayableYtStream(videoId, initialPlayerJson = null) {
    const initialUrl = extractDirectYtUrl(initialPlayerJson, false);
    if (initialUrl && !/[?&]c=WEB\b/i.test(initialUrl)) return initialUrl;
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || '').trim())) return '';

    const visitorData =
      (typeof window.ytcfg?.get === 'function' &&
        (window.ytcfg.get('VISITOR_DATA') ||
          window.ytcfg.get('INNERTUBE_CONTEXT')?.client?.visitorData)) ||
      '';

    const playerClients = [
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

    for (let i = 0; i < playerClients.length; i++) {
      try {
        const client = playerClients[i];
        const res = await origFetch(
          `https://www.youtube.com/youtubei/v1/player?prettyPrint=false&sf_client=${encodeURIComponent(client.clientName)}`,
          {
            method: 'POST',
            credentials: 'omit',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              videoId,
              contentCheckOk: true,
              racyCheckOk: true,
              context: { client }
            })
          }
        );
        if (!res.ok) continue;
        const json = await res.json().catch(() => null);
        const directUrl = extractDirectYtUrl(json, true);
        if (directUrl) return directUrl;
      } catch {}
    }
    return '';
  }

  // Active YouTube Innertube enricher for exact Views, Likes, Comments, Publish Dates, Duration & Captions
  window.addEventListener('SF_FETCH_YT_METRICS', async (e) => {
    const rawIds = Array.isArray(e.detail?.videoIds) ? e.detail.videoIds : [];
    const videoIds = Array.from(
      new Set(rawIds.map((id) => String(id || '').trim()).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))
    ).slice(0, 120);

    try {
      scanEmbeddedJsonScripts();
      if (videoIds.length > 0) {
        const ytContext =
          (typeof window.ytcfg?.get === 'function' && window.ytcfg.get('INNERTUBE_CONTEXT')) || {
            client: { clientName: 'WEB', clientVersion: '2.20250312.04.00', hl: 'en' }
          };
        const apiKey =
          (typeof window.ytcfg?.get === 'function' && window.ytcfg.get('INNERTUBE_API_KEY')) || '';
        const querySuffix = apiKey ? `?key=${encodeURIComponent(apiKey)}&prettyPrint=false` : '?prettyPrint=false';

        for (let i = 0; i < videoIds.length; i += 6) {
          const batch = videoIds.slice(i, i + 6);
          const enrichedBatch = await Promise.all(
            batch.map(async (videoId) => {
              try {
                const [playerRes, nextRes] = await Promise.all([
                  origFetch(`https://www.youtube.com/youtubei/v1/player${querySuffix}`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ videoId, context: ytContext })
                  }).catch(() => null),
                  origFetch(`https://www.youtube.com/youtubei/v1/next${querySuffix}`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ videoId, context: ytContext })
                  }).catch(() => null)
                ]);

                const serverDateHdr =
                  playerRes?.headers?.get?.('date') ||
                  nextRes?.headers?.get?.('date') ||
                  '';
                updateServerClockFromHeader(serverDateHdr);
                const playerJson = playerRes?.ok ? await playerRes.json().catch(() => null) : null;
                const nextJson = nextRes?.ok ? await nextRes.json().catch(() => null) : null;

                const vd = playerJson?.videoDetails || {};
                const mf = playerJson?.microformat?.playerMicroformatRenderer || {};
                const nextStats = nextJson ? extractYtNextEngagement(nextJson) : { likes: 0, comments: 0 };
                const captionTracks = playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                const enTrack = captionTracks.find((t) => /^en/i.test(t.languageCode || '')) || captionTracks[0];
                const pubStr = mf.publishDate || mf.uploadDate || '';
                const pubMs = pubStr ? Date.parse(pubStr) : NaN;
                let alignedPubAt = 0;
                let exactAgeDays = null;
                if (!isNaN(pubMs) && pubMs > 0) {
                  alignedPubAt = pubMs;
                  exactAgeDays = Math.max(
                    0,
                    Math.round(((getServerNow() - pubMs) / 86400000) * 100) / 100
                  );
                }
                const thumbUrl =
                  vd.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ||
                  mf.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ||
                  `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

                if (!vd.videoId && !nextStats.likes && !nextStats.comments) return null;

                return {
                  id: `yt_${videoId}`,
                  shortcode: videoId,
                  platform: 'youtube',
                  thumbnail: thumbUrl,
                  videoUrl: '',
                  subtitleUrl: enTrack?.baseUrl || '',
                  views: Number(vd.viewCount) || Number(mf.viewCount) || 0,
                  likes: Math.max(Number(mf.likeCount) || 0, nextStats.likes || 0),
                  comments: nextStats.comments || 0,
                  title: String(vd.title || ''),
                  caption: String(vd.shortDescription || vd.title || ''),
                  author: String(vd.author || ''),
                  duration: formatDurationSec(vd.lengthSeconds || mf.lengthSeconds),
                  category: String(mf.category || ''),
                  publishedText: pubStr,
                  publishedAt: alignedPubAt,
                  relativeAgeDays: exactAgeDays,
                  hasExactTimestamp: alignedPubAt > 0
                };
              } catch {
                return null;
              }
            })
          );

          const validPosts = enrichedBatch.filter(Boolean);
          if (validPosts.length > 0) emitPosts(validPosts);
        }
      }
    } catch {}
    window.dispatchEvent(new CustomEvent('SF_FETCH_YT_COMPLETE'));
  });

  // On-demand single-video YouTube stream URL resolver (ANDROID_VR, IOS, then active WEB context)
  window.addEventListener('SF_RESOLVE_YT_STREAM', async (e) => {
    const videoId = String(e.detail?.videoId || '').trim();
    let resolvedUrl = '';
    try {
      if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        resolvedUrl = await fetchPlayableYtStream(videoId);

        if (!resolvedUrl) {
          const apiKey =
            (typeof window.ytcfg?.get === 'function' && window.ytcfg.get('INNERTUBE_API_KEY')) || '';
          const querySuffix = apiKey ? `?key=${encodeURIComponent(apiKey)}&prettyPrint=false` : '?prettyPrint=false';
          const ytContext =
            (typeof window.ytcfg?.get === 'function' && window.ytcfg.get('INNERTUBE_CONTEXT')) || {
              client: { clientName: 'WEB', clientVersion: '2.20250312.04.00', hl: 'en' }
            };
          const webRes = await origFetch(`https://www.youtube.com/youtubei/v1/player${querySuffix}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ videoId, context: ytContext })
          }).catch(() => null);
          const webJson = webRes?.ok ? await webRes.json().catch(() => null) : null;
          resolvedUrl = extractDirectYtUrl(webJson, false);
        }

        if (resolvedUrl) {
          emitPosts([
            {
              id: `yt_${videoId}`,
              shortcode: videoId,
              platform: 'youtube',
              videoUrl: resolvedUrl
            }
          ]);
        }
      }
    } catch {}
    window.dispatchEvent(
      new CustomEvent(`SF_RESOLVED_YT_STREAM_${videoId}`, {
        detail: { videoId, videoUrl: resolvedUrl }
      })
    );
  });
})();
