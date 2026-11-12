// ==UserScript==
// @name         Cinema Archive — IMDb Sync
// @namespace    https://github.com/PerdangaSoftware/cinema-archive
// @version      2.2.0
// @description  Синхронизирует Watchlist, Watched и оценки (1–10) с IMDb в Cinema Archive по нажатию кнопки.
// @author       Roman Zhdanov
// @match        https://www.imdb.com/*
// @match        https://m.imdb.com/*
// @updateURL    https://raw.githubusercontent.com/PerdangaSoftware/cinema-archive/main/userscript/cinema-archive-imdb-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/PerdangaSoftware/cinema-archive/main/userscript/cinema-archive-imdb-sync.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      api.github.com
// @connect      www.imdb.com
// @connect      m.imdb.com
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const REPO = 'PerdangaSoftware/cinema-archive';
  const WORKFLOW_FILE = 'sync.yml';
  const DEFAULT_IMDB_USER_ID = 'p.bfyntw4ig4xmx4kpbpecvzehwa';

  const KEY_TOKEN = 'ca_github_token';
  const KEY_USER_ID = 'ca_imdb_user_id';
  const KEY_COLLECT_PREFIX = 'ca_collected_';

  const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const searchParams = new URLSearchParams(location.search);
  const collectMode = hashParams.get('ca_collect') || searchParams.get('ca_collect');
  const collectNonce = hashParams.get('ca_nonce') || searchParams.get('ca_nonce');

  let isSyncing = false;
  let toastHideTimer = null;
  let tokenPromptDismissed = false;

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getUserId() {
    const m = location.pathname.match(/\/user\/(ur\d+|p\.[a-z0-9]+)/i);
    if (m && m[1]) {
      GM_setValue(KEY_USER_ID, m[1]);
      return m[1];
    }
    return GM_getValue(KEY_USER_ID, DEFAULT_IMDB_USER_ID) || DEFAULT_IMDB_USER_ID;
  }

  function getToken(promptIfMissing = false) {
    let token = GM_getValue(KEY_TOKEN, '');
    let lsToken = '';
    try {
      const raw = localStorage.getItem('cinema_archive_token');
      if (raw && raw.trim()) lsToken = raw.trim();
    } catch (e) {}

    if (!token && promptIfMissing && !tokenPromptDismissed) {
      const entered = prompt(
        'Cinema Archive Sync: Введите GitHub Personal Access Token (repo + workflow):',
        lsToken
      );
      if (entered && entered.trim()) {
        token = entered.trim();
        GM_setValue(KEY_TOKEN, token);
        try { localStorage.setItem('cinema_archive_token', token); } catch (e) {}
        showToast('<div style="font-weight:600;color:#10b981;">✓ GitHub токен сохранён</div>', 3500, '#10b981');
      } else {
        tokenPromptDismissed = true;
      }
    }
    return token;
  }

  function clearToken() {
    GM_deleteValue(KEY_TOKEN);
    try { localStorage.removeItem('cinema_archive_token'); } catch (e) {}
  }

  function showToast(html, durationMs = 0, borderColor = '#d4a373') {
    const parent = document.body || document.documentElement;
    if (!parent) return;
    let box = document.getElementById('ca-userscript-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ca-userscript-toast';
      box.style.cssText = [
        'position:fixed',
        'bottom:74px',
        'right:24px',
        'background:#111114',
        'color:#f4f4f6',
        'border:1px solid ' + borderColor,
        'border-radius:12px',
        'padding:14px 18px',
        'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
        'font-size:13px',
        'box-shadow:0 12px 32px rgba(0,0,0,0.75)',
        'z-index:2147483647',
        'max-width:350px',
        'line-height:1.45'
      ].join(';');
      parent.appendChild(box);
    }
    box.style.borderColor = borderColor;
    box.innerHTML = html;
    if (toastHideTimer) clearTimeout(toastHideTimer);
    if (durationMs > 0) {
      toastHideTimer = setTimeout(() => {
        const el = document.getElementById('ca-userscript-toast');
        if (el) el.remove();
      }, durationMs);
    }
  }

  function setFloatingButtonState(loading) {
    const btn = document.getElementById('ca-sync-floating-btn');
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? '⏳ Syncing...' : '🔄 Sync IMDb';
    btn.style.opacity = loading ? '0.75' : '1';
  }

  function mountFloatingButton() {
    if (!document.body || document.getElementById('ca-sync-floating-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'ca-sync-floating-btn';
    btn.type = 'button';
    btn.textContent = '🔄 Sync IMDb';
    btn.title = 'Синхронизировать Watchlist, Watched и оценки с Cinema Archive';
    btn.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'right:24px',
      'background:#111114',
      'color:#d4a373',
      'border:1px solid #d4a373',
      'border-radius:999px',
      'padding:10px 16px',
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
      'font-size:13px',
      'font-weight:600',
      'cursor:pointer',
      'box-shadow:0 8px 24px rgba(0,0,0,0.65)',
      'z-index:2147483646'
    ].join(';');
    btn.addEventListener('click', () => runSync());
    document.body.appendChild(btn);
  }

  function extractFromNextData(doc, isRatingsPage) {
    const ids = [];
    const seen = new Set();
    const ratings = {};
    let totalCount = null;

    try {
      const script = doc.querySelector('#__NEXT_DATA__');
      if (!script || !script.textContent) return { ids, ratings, totalCount };
      const json = JSON.parse(script.textContent);
      const main = json && json.props && json.props.pageProps && json.props.pageProps.mainColumnData;
      if (!main || typeof main !== 'object') return { ids, ratings, totalCount };

      const listSearch =
        (main.predefinedList && main.predefinedList.titleListItemSearch) ||
        main.titleListItemSearch ||
        main.advancedTitleSearch ||
        (main.list && main.list.titleListItemSearch);

      if (listSearch && typeof listSearch === 'object') {
        if (typeof listSearch.total === 'number') {
          totalCount = listSearch.total;
        }
        const edges = Array.isArray(listSearch.edges) ? listSearch.edges : [];
        edges.forEach(edge => {
          const node = edge && edge.node;
          const titleObj = (node && (node.title || node)) || null;
          const id = titleObj && typeof titleObj.id === 'string' && /^tt\d{7,10}$/.test(titleObj.id)
            ? titleObj.id
            : null;
          if (!id) return;
          if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
          }
          if (isRatingsPage) {
            const ratingObj =
              (node && (node.userRating || node.viewerRating || node.authorRating || node.personalRating)) ||
              (titleObj && (titleObj.userRating || titleObj.viewerRating));
            const rawRating = (ratingObj && typeof ratingObj === 'object')
              ? (ratingObj.value ?? ratingObj.rating ?? ratingObj.score)
              : ratingObj;
            if (rawRating !== undefined && rawRating !== null) {
              const str = String(rawRating).trim();
              if (/^(10|[1-9])$/.test(str)) {
                ratings[id] = str;
              }
            }
          }
        });
      }
    } catch (e) {}

    return { ids, ratings, totalCount };
  }

  function extractFromDocument(doc, isRatingsPage) {
    const items = Array.from(doc.querySelectorAll('li.ipc-metadata-list-summary-item, .lister-item'))
      .filter(el => !el.closest('aside, nav, header, footer, .ipc-page-grid__sidebar, [data-testid*="sidebar"]'));

    const domIds = [];
    const seen = new Set();
    const domRatings = {};

    items.forEach(el => {
      const a = el.querySelector('a[href*="/title/tt"]');
      if (!a) return;
      const href = a.getAttribute('href') || a.href || '';
      const m = href.match(/tt\d{7,10}/);
      if (!m) return;
      const id = m[0];
      if (!seen.has(id)) {
        seen.add(id);
        domIds.push(id);
      }
      if (isRatingsPage) {
        let rv = '';
        const rEl = el.querySelector(
          '[data-testid="ratingGroup--other-user-rating"] .ipc-rating-star--rating,' +
          '.ipc-rating-star--otherUser .ipc-rating-star--rating,' +
          '[data-testid="ratingGroup--user-rating"] .ipc-rating-star--rating,' +
          '[data-testid="rate-button"] .ipc-rating-star--rating,' +
          '.ipc-rating-star--user .ipc-rating-star--rating,' +
          '.ipl-rating-widget .ipl-rating-star--other-user .ipl-rating-star__rating'
        );
        if (rEl) {
          const txt = rEl.textContent.trim();
          if (/^(10|[1-9])$/.test(txt)) rv = txt;
        }
        if (!rv) {
          const lblEl = el.querySelector(
            '[data-testid="ratingGroup--other-user-rating"], ' +
            '[data-testid="ratingGroup--user-rating"], ' +
            'button[aria-label*="rating"], ' +
            'button[aria-label*="Rated"]'
          );
          const lbl = lblEl ? (lblEl.getAttribute('aria-label') || '') : '';
          const lm = lbl.match(/(?:User|Your)\s+rating:\s*(10|[1-9])\b/i) || lbl.match(/Rated\s+(10|[1-9])\b/i);
          if (lm) rv = lm[1];
        }
        if (rv) domRatings[id] = rv;
      }
    });

    const nextRes = extractFromNextData(doc, isRatingsPage);
    let totalCount = nextRes.totalCount;
    if (totalCount === null) {
      const totalEl = doc.querySelector('[data-testid="list-page-mc-total-items"]');
      if (totalEl) {
        const tm = totalEl.textContent.replace(/,/g, '').match(/(\d+)/);
        if (tm) totalCount = parseInt(tm[1], 10);
      }
    }

    const useNext = nextRes.ids.length > domIds.length;
    const ids = useNext ? nextRes.ids : domIds;
    const ratings = useNext ? { ...domRatings, ...nextRes.ratings } : { ...nextRes.ratings, ...domRatings };

    const validPage = Boolean(
      ids.length > 0 ||
      doc.querySelector('[data-testid="list-page-mc-total-items"], .ipc-metadata-list, #__NEXT_DATA__')
    );

    const isCompleteList = totalCount === null
      ? ids.length > 0
      : ids.length >= totalCount;

    return { ids, ratings, validPage, totalCount, isCompleteList, domCount: domIds.length };
  }

  async function fetchImdbList(pathSuffix, isRatingsPage) {
    const userId = getUserId();
    const baseUrl = `${location.origin}/user/${userId}/${pathSuffix}/`;

    const allIds = [];
    const seen = new Set();
    const allRatings = {};
    let totalCount = null;
    let validPage = false;

    for (let page = 1; page <= 15; page++) {
      const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
      const resp = await fetch(url, { credentials: 'include', cache: 'no-store' });
      if (!resp.ok) {
        if (page === 1) throw new Error(`IMDb ${pathSuffix} HTTP ${resp.status}`);
        break;
      }
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const parsed = extractFromDocument(doc, isRatingsPage);
      if (parsed.validPage) validPage = true;
      if (parsed.totalCount !== null && totalCount === null) {
        totalCount = parsed.totalCount;
      }

      let addedOnPage = 0;
      parsed.ids.forEach(id => {
        if (!seen.has(id)) {
          seen.add(id);
          allIds.push(id);
          addedOnPage++;
        }
      });
      Object.assign(allRatings, parsed.ratings);

      if (addedOnPage === 0) break;
      if (totalCount !== null && allIds.length >= totalCount) break;
      if (parsed.ids.length === 0) break;
    }

    const isCompleteList = totalCount === null
      ? allIds.length > 0
      : allIds.length >= totalCount;

    return { ids: allIds, ratings: allRatings, validPage, totalCount, isCompleteList };
  }

  function tryExpandListPage() {
    const seeMoreBtn = Array.from(document.querySelectorAll('main button, .ipc-see-more button')).find(btn => {
      const txt = (btn.textContent || '').trim();
      return /^(?:see\s+all|see\s+more|load\s+more|\d+\s+more|all)$/i.test(txt) && !btn.disabled;
    });
    if (seeMoreBtn) {
      seeMoreBtn.click();
      return true;
    }
    window.scrollTo(0, document.body.scrollHeight);
    return false;
  }

  function runBackgroundCollector(mode, nonce) {
    const isRatings = mode === 'ratings';
    const key = KEY_COLLECT_PREFIX + mode;
    const startedAt = Date.now();
    let lastExpandAt = 0;
    let lastRatingCount = -1;
    let stableTicks = 0;

    showToast(`<div style="font-weight:600;color:#d4a373;">Cinema Archive Sync</div>Чтение ${escapeHtml(mode)}... вкладка закроется автоматически.`);

    const timer = setInterval(() => {
      const res = extractFromDocument(document, isRatings);
      const rCount = Object.keys(res.ratings).length;
      const elapsed = Date.now() - startedAt;

      const needExpand = res.totalCount !== null && (
        res.ids.length < res.totalCount ||
        res.domCount < res.totalCount ||
        (isRatings && rCount < res.totalCount)
      );
      if (needExpand && Date.now() - lastExpandAt > 1100) {
        lastExpandAt = Date.now();
        tryExpandListPage();
      }

      if (rCount === lastRatingCount && rCount > 0) {
        stableTicks++;
      } else {
        lastRatingCount = rCount;
        stableTicks = 0;
      }

      showToast(
        `<div style="font-weight:600;color:#d4a373;">Cinema Archive Sync</div>` +
        `Загрузка ${escapeHtml(mode)}: <b>${Math.max(res.ids.length, res.domCount)}</b>` +
        (res.totalCount !== null ? ` / ${res.totalCount}` : '') +
        (isRatings ? ` (оценок: <b>${rCount}</b>)` : '')
      );

      const itemsReady = res.validPage && res.ids.length > 0 && res.isCompleteList;
      const ratingsReady = !isRatings || (rCount >= res.ids.length) || (rCount > 0 && (!needExpand || stableTicks >= 6));
      const timedOut = elapsed >= 22000;

      if ((itemsReady && ratingsReady) || timedOut) {
        clearInterval(timer);
        GM_setValue(key, JSON.stringify({
          nonce,
          timestamp: Date.now(),
          ...res
        }));
        try { window.close(); } catch (e) {}
      }
    }, 450);
  }

  function collectViaBackgroundTab(pathSuffix) {
    if (typeof GM_openInTab !== 'function') {
      return Promise.resolve(null);
    }

    const userId = getUserId();
    const nonce = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const key = KEY_COLLECT_PREFIX + pathSuffix;
    const url = `${location.origin}/user/${userId}/${pathSuffix}/#ca_collect=${encodeURIComponent(pathSuffix)}&ca_nonce=${encodeURIComponent(nonce)}`;

    return new Promise((resolve) => {
      let settled = false;
      let listenerId = null;
      let pollId = null;
      let timeoutId = null;
      let tabHandle = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (pollId) clearInterval(pollId);
        if (timeoutId) clearTimeout(timeoutId);
        if (listenerId !== null && typeof GM_removeValueChangeListener === 'function') {
          try { GM_removeValueChangeListener(listenerId); } catch (e) {}
        }
        if (tabHandle && typeof tabHandle.close === 'function') {
          try { tabHandle.close(); } catch (e) {}
        }
        resolve(result);
      };

      const checkRaw = (raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.nonce === nonce) {
            finish(parsed);
          }
        } catch (e) {}
      };

      if (typeof GM_addValueChangeListener === 'function') {
        listenerId = GM_addValueChangeListener(key, (_name, _oldVal, newVal) => checkRaw(newVal));
      }

      pollId = setInterval(() => {
        checkRaw(GM_getValue(key, ''));
      }, 450);

      timeoutId = setTimeout(() => finish(null), 25000);

      tabHandle = GM_openInTab(url, { active: true, insert: true, setParent: true });
    });
  }

  function dispatchGitHubSync(inputs) {
    const token = getToken(true);
    if (!token) {
      return Promise.reject(new Error('Токен GitHub не указан'));
    }

    const endpoint = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
    const payload = JSON.stringify({ ref: 'main', inputs });

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: endpoint,
        headers: {
          'Authorization': 'token ' + token,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        data: payload,
        onload: (res) => resolve({ status: res.status, text: res.responseText || '' }),
        onerror: () => reject(new Error('Ошибка сети при обращении к GitHub API'))
      });
    });
  }

  async function runSync() {
    if (isSyncing) return;
    isSyncing = true;
    setFloatingButtonState(true);

    try {
      const userId = getUserId();
      const onWatchlist = /\/user\/[^/]+\/watchlist(\/|$|\?)/i.test(location.pathname);
      const onRatings = /\/user\/[^/]+\/ratings(\/|$|\?)/i.test(location.pathname);

      let watchlistRes = onWatchlist ? extractFromDocument(document, false) : null;
      let ratingsRes = onRatings ? extractFromDocument(document, true) : null;

      showToast('<div style="font-weight:600;color:#d4a373;margin-bottom:4px;">Cinema Archive Sync</div>Чтение Watchlist и Ratings с IMDb...');

      const [wlFetch, rtFetch] = await Promise.all([
        onWatchlist ? Promise.resolve(watchlistRes) : fetchImdbList('watchlist', false).catch(() => null),
        onRatings ? Promise.resolve(ratingsRes) : fetchImdbList('ratings', true).catch(() => null)
      ]);
      watchlistRes = wlFetch;
      ratingsRes = rtFetch;

      const needWatchlistTab = !onWatchlist && (!watchlistRes || !watchlistRes.validPage || !watchlistRes.isCompleteList);
      const needRatingsTab = !onRatings && (!ratingsRes || !ratingsRes.validPage || !ratingsRes.isCompleteList || Object.keys(ratingsRes.ratings || {}).length === 0);

      if (needWatchlistTab) {
        showToast('<div style="font-weight:600;color:#d4a373;margin-bottom:4px;">Cinema Archive Sync</div>Загрузка полного Watchlist во временной вкладке...');
        const wlBg = await collectViaBackgroundTab('watchlist');
        if (wlBg) watchlistRes = wlBg;
      }

      if (needRatingsTab) {
        showToast('<div style="font-weight:600;color:#d4a373;margin-bottom:4px;">Cinema Archive Sync</div>Загрузка оценок Ratings во временной вкладке...');
        const rtBg = await collectViaBackgroundTab('ratings');
        if (rtBg) ratingsRes = rtBg;
      }

      const inputs = {};
      const changes = [];
      const warnings = [];

      if (watchlistRes && watchlistRes.validPage && watchlistRes.ids.length > 0) {
        if (watchlistRes.isCompleteList) {
          inputs.ids = watchlistRes.ids.join(',');
          changes.push(`Watchlist: <b>${watchlistRes.ids.length}</b>`);
        } else {
          const got = watchlistRes.ids.length;
          const total = watchlistRes.totalCount;
          warnings.push(
            `Watchlist загружен частично (${got} из ${total}) — <a href="https://www.imdb.com/user/${encodeURIComponent(userId)}/watchlist/" style="color:#d4a373;text-decoration:underline;">откройте Watchlist</a>, прокрутите до конца и нажмите Sync.`
          );
        }
      }

      if (ratingsRes && ratingsRes.validPage && ratingsRes.ids.length > 0) {
        const ratingsCount = Object.keys(ratingsRes.ratings || {}).length;
        if (ratingsCount > 0) {
          inputs.watched_ids = ratingsRes.ids.join(',');
          inputs.ratings_json = JSON.stringify(ratingsRes.ratings);
          if (ratingsRes.isCompleteList && ratingsCount >= Math.floor(ratingsRes.ids.length * 0.9)) {
            inputs.replace_ratings = 'true';
          }
          changes.push(`Watched: <b>${ratingsRes.ids.length}</b> (оценок: <b>${ratingsCount}</b>)`);
        } else {
          warnings.push(
            `Не удалось прочитать оценки (найдено тайтлов: ${ratingsRes.ids.length}, оценок: 0) — <a href="https://www.imdb.com/user/${encodeURIComponent(userId)}/ratings/" style="color:#d4a373;text-decoration:underline;">откройте Ratings</a> и нажмите Sync.`
          );
        }
      }

      if (!Object.keys(inputs).length) {
        showToast(
          '<div style="font-weight:600;color:#ef4444;margin-bottom:4px;">Cinema Archive Sync</div>' +
          (warnings.length ? warnings.join('<br>') : 'Не удалось получить списки с IMDb. Откройте /watchlist/ или /ratings/ и повторите.'),
          7000,
          '#ef4444'
        );
        return;
      }

      showToast(
        '<div style="font-weight:600;color:#d4a373;margin-bottom:4px;">Cinema Archive Sync</div>' +
        changes.join('<br>') +
        '<br>Отправка в GitHub Actions...'
      );

      const res = await dispatchGitHubSync(inputs);

      if (res.status === 204) {
        const warnBlock = warnings.length
          ? `<div style="margin-top:6px;font-size:12px;color:#fbbf24;">${warnings.join('<br>')}</div>`
          : '';
        showToast(
          '<div style="font-weight:600;color:#10b981;margin-bottom:4px;">✓ Синхронизация запущена!</div>' +
          changes.join(' &bull; ') +
          warnBlock +
          '<br><span style="color:#9c9ca6;font-size:12px;">Сайт обновится на GitHub Pages через ~30 секунд.</span>',
          warnings.length ? 8000 : 5000,
          '#10b981'
        );
      } else if (res.status === 401) {
        clearToken();
        showToast(
          '<div style="font-weight:600;color:#ef4444;margin-bottom:4px;">✕ Неверный GitHub токен (401)</div>' +
          '<div style="color:#9c9ca6;font-size:12px;">Токен сброшен. Нажмите Sync ещё раз, чтобы ввести новый.</div>',
          6000,
          '#ef4444'
        );
      } else {
        let msg = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(res.text);
          if (parsed && parsed.message) msg = parsed.message;
        } catch (e) {}
        showToast(
          `<div style="font-weight:600;color:#ef4444;margin-bottom:4px;">✕ Ошибка GitHub (${escapeHtml(res.status)})</div>` +
          `<div style="color:#9c9ca6;font-size:12px;">${escapeHtml(msg)}</div>`,
          6000,
          '#ef4444'
        );
      }
    } catch (err) {
      showToast(
        '<div style="font-weight:600;color:#ef4444;margin-bottom:4px;">✕ Ошибка синхронизации</div>' +
        `<div style="color:#9c9ca6;font-size:12px;">${escapeHtml(err && err.message ? err.message : String(err))}</div>`,
        5000,
        '#ef4444'
      );
    } finally {
      isSyncing = false;
      setFloatingButtonState(false);
    }
  }

  function ensureTokenOnStartup() {
    if (!GM_getValue(KEY_TOKEN, '')) {
      setTimeout(() => getToken(true), 400);
    }
  }

  if (collectMode && collectNonce) {
    runBackgroundCollector(collectMode, collectNonce);
    return;
  }

  mountFloatingButton();
  ensureTokenOnStartup();

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🔄 Синхронизировать IMDb сейчас', () => {
      tokenPromptDismissed = false;
      runSync();
    });
    GM_registerMenuCommand('🔑 Задать / сменить GitHub токен', () => {
      const entered = prompt('Введите GitHub Personal Access Token (repo + workflow):', GM_getValue(KEY_TOKEN, ''));
      if (entered && entered.trim()) {
        tokenPromptDismissed = false;
        GM_setValue(KEY_TOKEN, entered.trim());
        try { localStorage.setItem('cinema_archive_token', entered.trim()); } catch (e) {}
        showToast('<div style="font-weight:600;color:#10b981;">✓ GitHub токен сохранён</div>', 3000, '#10b981');
      }
    });
    GM_registerMenuCommand('🆔 Задать IMDb User ID', () => {
      const entered = prompt('Введите ваш IMDb User ID (например p.bfyntw4ig4xmx4kpbpecvzehwa):', getUserId());
      if (entered && entered.trim()) {
        GM_setValue(KEY_USER_ID, entered.trim());
        showToast('<div style="font-weight:600;color:#10b981;">✓ IMDb User ID сохранён</div>', 3000, '#10b981');
      }
    });
  }
})();
