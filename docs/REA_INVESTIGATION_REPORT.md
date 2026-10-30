# REA Investigation & Clean-Room Reconstruction Report: Sort Feed (`sortfeed.com`)

**Skill Applied:** [`reverse-engineer-anything`](../.agents/skills/reverse-engineer-anything/SKILL.md) (`morluto/rea`)  
**Target Analyzed:** `https://www.sortfeed.com/getting-started` and `https://www.sortfeed.com/docs/*`  
**Output Artifact:** **ShortFeed** — Chrome Extension (Manifest V3)

---

## 1. Investigation Checklist & Evidence Ledger

Following the staged REA workflow (`SKILL.md` § *Plan broader investigations*), we decomposed the target into verifiable questions backed by shipped web bundle artifacts, video captures, and documentation schemas:

| ID | Investigation Question | Evidence Source | Confidence / Type | Status |
| :--- | :--- | :--- | :--- | :--- |
| **E-01** | How is the onboarding & step-by-step interactive walkthrough structured on `/getting-started`? | `/_next/static/chunks/1du0tsux7k1ge.js` (Turbopack module `55950`), RSC Flight payload on `/getting-started` | Static Bundle + DOM Inspection (High) | Answered |
| **E-02** | What is the exact UI layout and interaction flow of the toolbar popup? | `getting-started-02.mp4` (`00:02–00:05`), `/docs/getting-started/your-first-sort`, `/docs/sorting/how-sorting-works` | Visual Frame + Spec Corroboration (High) | Answered |
| **E-03** | How does the extension collect posts and display progress while sorting? | `getting-started-02.mp4` (`00:06–00:08`), `/docs/sorting/how-sorting-works` | Visual Frame + Behavioral Spec (High) | Answered |
| **E-04** | How is the **Outlier Score** mathematically computed and badged? | `/docs/sorting/outlier-score`, `getting-started-02.mp4` (`00:10–00:15`), `getting-started-03-poster.jpg` | Mathematical Spec + Visual Verification (High) | Answered |
| **E-05** | What controls exist on the injected post-sort control banner and filter popover? | `getting-started-02.mp4` (`00:09–00:15`), `/docs/sorting/after-you-sort` | Visual Frame + Behavioral Spec (High) | Answered |
| **E-06** | How does the in-page Video Player modal work, including keyboard shortcuts and actions? | `getting-started-03.mp4` (`00:02–00:17`), `/docs/player/watching-sorted-posts`, `/docs/player/controls-and-shortcuts` | Visual Frame + Behavioral Spec (High) | Answered |
| **E-07** | What are the exact export schemas across platforms (`Instagram`, `TikTok`, `Facebook`, `YouTube`)? | `/docs/exporting/exporting-your-data`, `/docs/exporting/google-sheets` | Schema Spec (High) | Answered |
| **E-08** | How do Save, Similar Accounts, Download, and Transcription operate? | `/docs/save/saving`, `/docs/save/your-saved-posts`, `/docs/sorting/similar-accounts`, `/docs/download-and-transcribe/*` | Behavioral Spec (High) | Answered |

---

## 2. Reconstructed Feature Specifications

### 2.1 Toolbar Popup State Machine (`E-02`)
Observed directly in `getting-started-02.mp4` (`00:02–00:05`):
1. **Header Bar**:
   - Left: Brand icon + `ShortFeed` title.
   - Right: Plan pill (`PRO` unlocked) + Settings gear button (`⚙`) + Saved Library button.
2. **`Filters` Section (Scope & Range)**:
   - Two segmented tabs: **`Posts`** (count-based) and **`Date`** (time-window-based).
   - **`Posts` Presets**: `Latest 25 Posts`, `Latest 50 Posts`, `Latest 100 Posts`, `Latest 200 Posts`, `Latest 1K Posts`, `All Posts`, and `Custom Posts...`.
   - **`Date` Presets**: `1 Week Back`, `1 Month Back`, `3 Months Back`, `6 Months Back`, `1 Year Back`, `All Time`, and `Custom Date Range...`.
3. **`Sort by` Section (Immediate Trigger)**:
   - Clicking a metric button closes the popup and immediately starts collection and sorting on the active tab:
     - `♥ Likes`
     - `▶ Views`
     - `⚡ Outlier score`
     - `💬 Comments`
     - `↗ Shares` (TikTok & Facebook)
     - `🔖 Saves` (TikTok)
     - `🕒 Oldest`
4. **Settings Drawer (`⚙`)**:
   - `Posts open in`: `Player` (in-page modal) vs `Platform` (new tab).
   - Hover button switches: `Save button`, `Download button`, `Transcribe button`.

---

### 2.2 Collection Engine & Progress Overlay (`E-03`)
Observed in `getting-started-02.mp4` (`00:06–00:08`):
- When a sort starts, the page is dimmed with a frosted-glass backdrop (`backdrop-filter: blur(8px)`) so the user doesn't accidentally scroll against the collector.
- A floating centered progress banner transitions from:
  - `Getting ready to sort`
  - `24 Reels sorted — don't scroll` with percentage (`100%`), an amber-gold progress bar, and a circular **Stop (`■`)** button on the right that halts collection immediately and ranks all posts gathered so far.
- **Collection Mechanism**:
  - Combines passive `MAIN`-world network interception (`window.fetch` / `XMLHttpRequest` JSON parsing for GraphQL/API responses on Instagram, TikTok, YouTube, and Facebook) with controlled programmatic scrolling and DOM grid extraction.

---

### 2.3 Outlier Score Algorithm (`E-04`)
Reconstructed from `/docs/sorting/outlier-score` and verified against `getting-started-02.mp4` (`00:13` tooltip: `12.8x — 12.8x more than usual` and `getting-started-03.mp4` `00:02` sidebar `Views: 167.8K`, `Outlier score: 12.8x`):
1. **Baseline Pool Selection**:
   - Take up to the 25 most recent posts from the creator.
   - Exclude posts published within the last **3 days** (`72 hours`) if mature posts exist, because brand-new posts have not finished accumulating views and would artificially depress the baseline.
2. **Median Calculation**:
   - Sort the baseline metric values ($M_1 \le M_2 \le \dots \le M_k$) where the metric is **Views** (for Reels/TikTok/YouTube/FB Reels) or **Likes** (for Instagram Posts tab).
   - Compute the statistical median:
     $$\text{Median} = \begin{cases} M_{(k+1)/2} & \text{if } k \text{ is odd} \\ \frac{M_{k/2} + M_{k/2 + 1}}{2} & \text{if } k \text{ is even} \end{cases}$$
3. **Multiplier & Lightning Badge Rationing**:
   - For each post $i$ with metric $v_i$:
     $$\text{OutlierScore}_i = \frac{v_i}{\max(1, \text{Median})}$$
   - Posts with $\text{OutlierScore}_i < 2.0\times$ show their multiplier (`1.4x`) in the bottom corner without a top-left lightning badge.
   - Posts with $\text{OutlierScore}_i \ge 2.0\times$ earn a dark pill lightning badge in the top-left corner (`getting-started-03-poster.jpg`):
     - `⚡⚡⚡` (3 bolts): Top breakout tier ($\ge 8\times$ or top 1–2 posts $\ge 4\times$).
     - `⚡⚡` (2 bolts): Strong breakout ($\ge 4\times$ or top 3–5 posts $\ge 2.5\times$).
     - `⚡` (1 bolt): Clear outlier ($\ge 2.0\times$).
   - Hovering the lightning badge displays: `"{score}x — {score}x more than usual ({post_views} vs {median_views} median)"`.

---

### 2.4 Sticky Sorted Banner, Histogram Filter & Select Mode (`E-05`)
Observed in `getting-started-03-poster.jpg` and `/docs/sorting/after-you-sort`:
- **Top Row Left**:
  - Dynamic title (`Top Outlier Reels`, `Reels Sorted by Views`, etc.) and subtitle (`Showing 25 Reels`).
- **Top Row Right (Action Bar)**:
  - `Similar`: Opens the Similar Accounts discovery panel (with 1-click open & export).
  - `✓ Select`: Toggles selection circles on every card, preserving selection order for targeted export, download, or bulk transcription.
  - `↓ Download N`: Downloads all visible (or selected) videos/posts.
  - `📋 Copy`: Formats visible/selected rows as Tab-Separated Values (TSV) on the clipboard so pasting into Google Sheets or Excel creates an instant structured table.
  - `↑ Export N`: Dropdown menu for **CSV**, **Excel (`.xlsx` / SpreadsheetML)**, **JSON**, and **Google Sheets** (copies formatted TSV + opens `https://sheets.new` ready to paste or downloads sheet).
- **Second Row (Instant Re-rank & Filter Bar)**:
  - `≡ Filters`: Opens a popover with:
    1. **Performance Range**: Metric selector + visual 16-bin distribution **Histogram** + `Min` / `Max` numeric inputs.
    2. **Posted Date**: `In the last N days/weeks/months/years` or `Between start & end dates`.
  - `⇅ Sort by`: Instant in-memory re-sorting of the already-collected grid (`Views`, `Likes`, `Outlier score`, `Comments`, `Shares`, `Saves`, `Oldest`).
  - `Clear all`: Resets active filters.

---

### 2.5 In-Page Video Player Modal (`E-06`)
Observed in `getting-started-03.mp4` (`00:02–00:17`):
- Split card modal (`max-width: 860px`, `aspect-ratio` video pane on left, `340px` white metadata & action sidebar on right):
  - **Left (Video/Carousel Stage)**:
    - Plays the post video or multi-slide carousel directly over the grid.
    - Floating dark pill control bar at bottom-left: Play/Pause (`Space`), `-5s` / `+5s` seek, playback rate (`0.5x`, `1x`, `1.5x`, `2x`, `3x`), Mute/Unmute (`M`, persisted in `chrome.storage.local`), and interactive scrubber with timestamp tooltip (`0:01 / 0:23`).
  - **Right (Sidebar)**:
    - Top navigation: `[1 of 25]` badge, `<` Prev (`ArrowLeft`), `>` Next (`ArrowRight`), and `×` Close (`Escape`).
    - Metrics table: `Views`, `Likes`, `Comments`, `Shares` (when applicable), `Saves` (when applicable), `Outlier score` (`12.8x`), and `Published` (`14 Sep 2026`).
    - Scrollable Caption & live Transcript viewer (with timestamped lines and `.txt` download).
    - Bottom actions: `Save to Library` (`S`), `Transcribe` (`T`), `Open on Platform`, and `⋯` overflow menu (`Download Video`, `Download Thumbnail`, `Copy Link`, `Copy Caption`, `Copy Row for Sheets`).

---

## 3. Clean-Room Chrome Extension Architecture (`ShortFeed`)

```
ShortFeed/
├── manifest.json                     # Manifest V3 Chrome Extension config
├── background.js                     # Service worker: downloads, storage sync, badge & library orchestration
├── icons/                            # 16, 32, 48, 128px extension icons
├── popup/
│   ├── popup.html                    # Extension toolbar popup UI
│   ├── popup.css                     # Sort Feed-inspired clean light/amber design system
│   └── popup.js                      # Platform detection, Filters/Sort trigger, Settings & Demo launcher
├── content/
│   ├── page-interceptor.js           # MAIN-world fetch/XHR interceptor for IG, TikTok, YouTube & FB APIs
│   ├── content.css                   # Injected styles: progress overlay, sorted banner, cards, player modal
│   └── content.js                    # Collection engine, Outlier Score math, banner, histogram filter, player
└── library/
    ├── library.html                  # Saved Posts Library (app.sortfeed.com equivalent) + Interactive Sandbox
    ├── library.css                   # Styling for saved collections, tags, notes & live sandbox
    └── library.js                    # Saved posts manager, search/filter/export, and built-in creator sandbox
```
