<div align="center">

# shortfeed-alternative

### The #1 Free & Open-Source Alternative to Sort Feed (`sortfeed.com`)

**Sort Instagram, TikTok, YouTube Shorts & Facebook Reels by Views, Likes, or Outlier Score. Download watermark-free videos, watch in an in-page modal player, and export straight to Google Sheets.**

[![Chrome Extension Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Platforms Supported](https://img.shields.io/badge/Platforms-Instagram%20%7C%20TikTok%20%7C%20YouTube%20%7C%20Facebook-purple.svg?style=flat-square)](#-supported-platforms--surfaces)
[![All Features Free](https://img.shields.io/badge/Pro%20Features-100%25%20Free%20%26%20Unlocked-amber.svg?style=flat-square&color=f59e0b)](#-why-shortfeed-alternative-vs-sort-feed)

<br />

<img src="assets/Shortfeed%20Alternative%20Dashboard%20Banner.png" alt="shortfeed-alternative Dashboard Banner" width="100%" />

<br />

</div>

---

## 📌 Overview

Looking for a powerful, privacy-first, 100% free alternative to **Sort Feed** (`sortfeed.com`)?

**`shortfeed-alternative`** is an open-source Google Chrome Extension (Manifest V3) designed for content creators, growth marketers, viral researchers, and video editors. It brings premium social feed sorting, outlier discovery, watermark-free media downloading, and spreadsheet export capabilities right into your browser without recurring subscription fees or post-count paywalls.

---

## ⚡ Why `shortfeed-alternative` vs. Sort Feed?

Sort Feed restricts users to 25 posts or a single week of data before requiring a **$10–$15/month subscription**. **`shortfeed-alternative`** removes every paywall:

| Feature / Capability | Sort Feed (`sortfeed.com`) | `shortfeed-alternative` (This Project) |
| :--- | :---: | :---: |
| **Pricing** | Free Tier / $10–$15 per month | **100% Free & Open-Source (MIT)** |
| **Post Sort Limits** | Capped at 25 posts on free plan | **Unlimited (25, 50, 100, 200, 1K, All & Custom)** |
| **Date Range Filters** | Capped at 7 days on free plan | **Unlimited (1W, 1M, 3M, 6M, 1Y, All Time & Custom)** |
| **Outlier Score Calculation** | Included with limits | **Included (Mathematical Median Baseline Engine)** |
| **Lightning Outlier Badges** | `⚡` to `⚡⚡⚡` badges | **`⚡` (2x), `⚡⚡` (4x), `⚡⚡⚡` (6x–10x+) + Tooltip Stats** |
| **Watermark-Free Video Downloads** | Supported | **Single `.mp4` & Bulk Multi-Video `.zip` Archive** |
| **Carousel Extraction** | Basic | **Automated Slide Unpacking (`.zip` with numbered files)** |
| **Browse-Without-Sorting Buttons** | Included | **Floating Hover Controls (`🔖 Save`, `↓ Download`, `文 Transcript`)** |
| **In-Page Video Player** | Included | **Keyboard-driven player (`←`, `→`, `Space`, `M`, `T`, `S`, `D`, `Esc`)** |
| **Audio Transcription** | Paywalled behind Pro | **Built-in timestamped transcription (`.txt` & export)** |
| **Export Formats** | CSV, Excel, Sheets, JSON | **Google Sheets (1-click auto-table), Excel, CSV, JSON** |
| **Saved Library & Swipe File** | 50-save cap on free plan | **Unlimited Local Collections, #Tags, Notes & Search** |
| **Interactive Creator Sandbox** | ❌ None | **Built-in simulator (test without logging in)** |
| **Data Privacy** | Cloud-dependent features | **100% Local (no accounts, tokens, or passwords sent)** |

---

## 🎯 Target Use Cases

- **Viral Content Ideation**: Surface the top 1% breakout video formats that performed 5x to 20x above an account's normal view numbers.
- **Competitor Analysis**: Analyze your competitors' past 50, 200, or 1,000 reels and videos to identify their winning hooks and topics.
- **Swipe File Creation**: Download watermark-free video references and organize them into tagged, searchable collections.
- **Direct-to-Sheets Research**: Export engagement metrics, outlier scores, links, and captions straight into Google Sheets or Excel with one click.

---

## 🚀 Key Features

### 1. 🧮 Statistical Outlier Score Engine
Raw views favor giant accounts with millions of followers. **Outlier Score** finds what truly overperformed:
1. Samples the creator's recent post pool, excluding premature posts (< 72 hours old).
2. Calculates the **statistical median** baseline view count ($M$).
3. Computes the ratio: $\text{OutlierScore} = \frac{\text{Post Views}}{\text{Creator Median Views}}$.
4. Breakout posts receive tiered lightning badges (`⚡`, `⚡⚡`, `⚡⚡⚡`) with an informative comparison tooltip on hover.

### 2. 📥 Watermark-Free Video & Bulk ZIP Downloads
- **Single Video Download**: Click `↓` on any card or press `D` inside the player to download clean HD `.mp4` or `.webm` files.
- **Carousel Slide Extraction**: Automatically packages multi-slide Instagram carousels into a `.zip` with individual numbered slides (`01_...`, `02_...`).
- **Bulk Batch Download**: Click **Download All** to download dozens of reels simultaneously with a live progress bar and organized `.zip` export.
- **Download While Browsing**: Hover over any video on Instagram, TikTok, or Facebook while scrolling your feed to save it directly without sorting first.

### 3. 🎬 In-Page Video Player Modal
Watch and analyze video content without leaving the sorted grid or losing your position:
- **Video Stage**: Vertical video player with seek controls, `-5s`/`+5s` skips, speed controls (`0.5x` to `3x`), and persistent mute state.
- **Metrics Sidebar**: Engagement breakdown, outlier multiples, publish dates, captions, and script transcription.
- **Keyboard Shortcuts**:
  - `←` / `→` : Previous / Next sorted post
  - `Space` : Play / Pause
  - `M` : Mute / Unmute
  - `D` : Download current video without watermarks
  - `S` : Save post to library swipe file
  - `T` : Transcribe video speech into timestamped text
  - `Esc` : Close player

### 4. 📊 Performance Range Distribution & Histogram Filter
- **16-Bin Distribution Histogram**: Visualize post performance distribution before filtering.
- **Min/Max Sliders & Inputs**: Filter for exact thresholds (e.g., *"Reels with > 100,000 views"*).
- **Date Range Restrictions**: Filter by the last 7 days, 30 days, 3 months, 1 year, or custom date ranges.
- **Instant In-Memory Re-Ranking**: Switch between **Outlier score**, **Views**, **Likes**, **Comments**, **Shares**, **Saves**, or **Oldest** instantly without re-scanning.

### 5. 📑 1-Click Multi-Format Exports
- **Google Sheets**: Generates formatted tables with bold headers, thousands separators, and clickable URLs via `sheets.new`.
- **Excel (`.xlsx` / `.xls`)**: Pre-formatted XML spreadsheets ready for desktop analysis.
- **CSV & JSON**: Standard structured files containing creator handles, links, publish dates, views, likes, comments, shares, saves, outlier multipliers, captions, and transcripts.

### 6. 🔖 Saved Posts Swipe File & Sandbox Workspace
- **Saved Library**: Organize saved reels into custom folders (e.g., *"Viral Hooks"*, *"Competitor Formats"*), add `#tags` and notes, and search through captions and transcripts.
- **Built-in Creator Sandbox**: Test sorting, filtering, and video downloads directly inside a simulated creator profile without logging into any social network.

---

## 🌐 Supported Platforms & Surfaces

| Platform | Supported Pages & Surfaces | Supported Metrics |
| :--- | :--- | :--- |
| **Instagram** | Profile Reels, Profile Posts, Explore Search, Saved All Posts, Saved Collections | Views, Likes, Outlier Score, Comments, Oldest |
| **TikTok** | Profile Videos, Search Results, Favorites, Liked Videos, Collections | Views, Likes, Comments, Shares, Saves, Outlier Score, Oldest |
| **Facebook** | Creator Profile Reels, User Published Reels, Saved Reels | Views, Likes, Comments, Shares, Outlier Score, Oldest |
| **YouTube** | Channel Videos Tab, Channel Shorts Tab | Views, Likes, Outlier Score, Duration, Title, Description, Oldest |

---

## 🛠️ Installation Guide (Google Chrome)

1. **Clone or Download this Repository**:
   ```bash
   git clone https://github.com/your-username/shortfeed-alternative.git
   ```
   *(Or click **Code** > **Download ZIP** and extract the folder).*

2. **Open Extensions in Chrome**:
   - Navigate to `chrome://extensions` in Google Chrome.

3. **Enable Developer Mode**:
   - Turn on the **Developer mode** toggle in the top-right corner.

4. **Load the Extension**:
   - Click **Load unpacked** (top-left).
   - Select the `shortfeed-alternative` root directory (containing `manifest.json`).

5. **Pin & Use**:
   - Click the puzzle icon (`🧩`) on your Chrome toolbar and pin **ShortFeed**.
   - Open any Instagram, TikTok, YouTube, or Facebook page, click the extension icon, and select a sort metric.
   - Or click **Demo Feed** in the popup to explore the interactive sandbox immediately.

---

## 🔒 Privacy & Safety First

- **No Passwords Required**: The extension never prompts for or stores passwords or session cookies.
- **Runs Entirely in Your Browser**: All metric calculations, sorting logic, and data exports occur locally on your machine.
- **Human-Like Pace**: Respects platform scrolling speeds and rate boundaries.

---

## 🤝 Contributing

Contributions, feedback, and bug reports are welcome!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/NewFeature`)
3. Commit your Changes (`git commit -m 'Add NewFeature'`)
4. Push to the Branch (`git push origin feature/NewFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.

---

## 🏷️ Search Keywords & SEO Tags

`shortfeed alternative` • `sort feed alternative` • `sortfeed-alternative` • `sort instagram reels by views` • `sort tiktok by views` • `instagram outlier score` • `download instagram reels without watermark` • `sort facebook reels` • `youtube shorts view sorter` • `viral hook swipe file` • `creator research extension` • `free sort feed chrome extension`
