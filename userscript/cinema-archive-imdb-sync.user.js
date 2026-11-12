// ==UserScript==
// @name         Cinema Archive — IMDb Auto Sync
// @namespace    https://github.com/PerdangaSoftware/cinema-archive
// @version      1.0.1
// @description  Автоматически синхронизирует Watchlist, Watched и оценки (1–10) с IMDb в Cinema Archive при изменениях на сайте.
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
// @grant        unsafeWindow
// @connect      api.github.com
// @connect      www.imdb.com
// @connect      m.imdb.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const REPO = 'PerdangaSoftware/cinema-archive';
  const WORKFLOW_FILE = 'sync.yml';
  const DEFAULT_IMDB_USER_ID = 'p.bfyntw4ig4xmx4kpbpecvzehwa';

  const KEY_TOKEN = 'ca_github_token';
  const KEY_USER_ID = 'ca_imdb_user_id';
  const KEY_STATE = 'ca_sync_state_v1';

  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  let syncTimer = null;
  let isSyncing = false;
  let pendingResync = false;
  let pendingReason = '';
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
    if (!token) {
      try {
        const lsToken = localStorage.getItem('cinema_archive_token');
        if (lsToken && lsToken.trim()) {
          token = lsToken.trim();
          GM_setValue(KEY_TOKEN, token);
        }
      } catch (e) {}
    }
    if (!token && promptIfMissing && !tokenPromptDismissed) {
      const entered = prompt('Cinema Archive Auto Sync: Введите GitHub Personal Access Token (repo + workflow):');
      if (entered && entered.trim()) {
        token = entered.trim();
        GM_setValue(KEY_TOKEN, token);
        try { localStorage.setItem('cinema_archive_token', token); } catch (e) {}
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

  function getSyncState() {
    try {
      const raw = GM_getValue(KEY_STATE, '');
      return raw ? JSON.parse(raw) : { watchlistHash: '', ratingsHash: '', lastSyncAt: 0 };
    } catch (e) {
      return { watchlistHash: '', ratingsHash: '', lastSyncAt: 0 };
    }
  }

  function saveSyncState(state) {
    GM_setValue(KEY_STATE, JSON.stringify(state));
  }

  function showToast(html, durationMs = 0, borderColor = '#d4a373') {
    const renderToast = () => {
      const parent = document.body || document.documentElement;
      if (!parent) return;
      let box = document.getElementById('ca-userscript-toast');
      if (!box) {
        box = document.createElement('div');
        box.id = 'ca-userscript-toast';
        box.style.cssText = [
          'position:fixed',
          'bottom:24px',
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
          'max-width:340px',
          'line-height:1.45',
          'transition:opacity 0.2s ease'
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
    };

    if (document.body) {
      renderToast();
    } else {
      window.addEventListener('DOMContentLoaded', renderToast, { once: true });
    }
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
            const rawRating =
              (node && node.userRating && node.userRating.value) ??
              (titleObj && titleObj.userRating && titleObj.userRating.value) ??
              (node && node.viewerRating && node.viewerRating.value);
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
          const lblEl = el.querySelector('[data-testid="ratingGroup--other-user-rating"], [data-testid="ratingGroup--user-rating"]');
          const lbl = lblEl ? (lblEl.getAttribute('aria-label') || '') : '';
          const lm = lbl.match(/(?:User|Your)\s+rating:\s*(10|[1-9])\b/i);
          if (lm) rv = lm[1];
        }
        if (rv) domRatings[id] = rv;
      }
    });

    if (!domIds.length && !isRatingsPage) {
      const main = doc.querySelector('main, [role="main"]') || doc.body;
      if (main) {
        Array.from(main.querySelectorAll('a[href*="/title/tt"]'))
          .filter(a => !a.closest('aside, nav, header, footer, .ipc-page-grid__sidebar, [data-testid*="sidebar"]'))
          .forEach(a => {
            const href = a.getAttribute('href') || a.href || '';
            const m = href.match(/tt\d{7,10}/);
            if (m && !seen.has(m[0])) {
              seen.add(m[0]);
              domIds.push(m[0]);
            }
          });
      }
    }

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

    const isCompleteList = totalCount === null || ids.length >= totalCount;

    return { ids, ratings, validPage, totalCount, isCompleteList };
  }

  async function fetchImdbList(pathSuffix, isRatingsPage) {
    const userId = getUserId();
    const url = `${location.origin}/user/${userId}/${pathSuffix}/`;
    const resp = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!resp.ok) {
      throw new Error(`IMDb ${pathSuffix} HTTP ${resp.status}`);
    }
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return extractFromDocument(doc, isRatingsPage);
  }

  function computeWatchlistHash(ids) {
    return ids.join(',');
  }

  function computeRatingsHash(ids, ratings) {
    const rKeys = Object.keys(ratings).sort();
    const rPart = rKeys.map(k => `${k}:${ratings[k]}`).join(',');
    return `${ids.join(',')}|${rPart}`;
  }

  function dispatchGitHubSync(inputs) {
    const token = getToken(true);
    if (!token) {
      return Promise.reject(new Error('Токен GitHub не указан'));
    }

    const endpoint = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
    const payload = JSON.stringify({ ref: 'main', inputs });

    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
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
      } else {
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': 'token ' + token,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: payload
        })
          .then(async res => ({ status: res.status, text: await res.text() }))
          .then(resolve)
          .catch(reject);
      }
    });
  }

  async function runSync({ force = false, reason = 'Авто-проверка', currentPageOnly = false } = {}) {
    if (isSyncing) {
      pendingResync = true;
      pendingReason = reason;
      return;
    }
    isSyncing = true;

    try {
      const onWatchlist = /\/user\/[^/]+\/watchlist(\/|$|\?)/i.test(location.pathname);
      const onRatings = /\/user\/[^/]+\/ratings(\/|$|\?)/i.test(location.pathname);

      let watchlistRes = null;
      let ratingsRes = null;

      if (onWatchlist) {
        watchlistRes = extractFromDocument(document, false);
        if (!currentPageOnly) {
          ratingsRes = await fetchImdbList('ratings', true).catch(() => null);
        }
      } else if (onRatings) {
        ratingsRes = extractFromDocument(document, true);
        if (!currentPageOnly) {
          watchlistRes = await fetchImdbList('watchlist', false).catch(() => null);
        }
      } else {
        const [wl, rt] = await Promise.all([
          fetchImdbList('watchlist', false).catch(() => null),
          fetchImdbList('ratings', true).catch(() => null)
        ]);
        watchlistRes = wl;
        ratingsRes = rt;
      }

      const prev = getSyncState();
      const inputs = {};
      let newWatchlistHash = prev.watchlistHash;
      let newRatingsHash = prev.ratingsHash;
      const changes = [];
      let skippedPartialWatchlist = false;

      if (watchlistRes && watchlistRes.validPage && watchlistRes.ids.length > 0) {
        if (!watchlistRes.isCompleteList && !force) {
          skippedPartialWatchlist = true;
        } else {
          const h = computeWatchlistHash(watchlistRes.ids);
          if (force || h !== prev.watchlistHash) {
            inputs.ids = watchlistRes.ids.join(',');
            newWatchlistHash = h;
            changes.push(`Watchlist: <b>${watchlistRes.ids.length}</b>`);
          }
        }
      }

      if (ratingsRes && ratingsRes.validPage && ratingsRes.ids.length > 0) {
        const h = computeRatingsHash(ratingsRes.ids, ratingsRes.ratings);
        if (force || h !== prev.ratingsHash) {
          inputs.watched_ids = ratingsRes.ids.join(',');
          inputs.ratings_json = JSON.stringify(ratingsRes.ratings);
          newRatingsHash = h;
          changes.push(`Watched: <b>${ratingsRes.ids.length}</b> (оценок: <b>${Object.keys(ratingsRes.ratings).length}</b>)`);
        }
      }

      if (!Object.keys(inputs).length) {
        if (skippedPartialWatchlist && !onWatchlist) {
          showToast(
            '<div style="font-weight:600;color:#d4a373;margin-bottom:4px;">Cinema Archive Sync</div>' +
            'Watchlist на IMDb подгрузился не полностью в фоне — откройте страницу Watchlist на пару секунд для синхронизации.',
            4500
          );
        } else if (force) {
          showToast(
            '<div style="font-weight:600;color:#d4a373;margin-bottom:4px;">Cinema Archive Sync</div>' +
            'Изменений на IMDb не обнаружено (данные уже актуальны).',
            3500
          );
        }
        return;
      }

      showToast(
        `<div style="font-weight:600;color:#d4a373;margin-bottom:4px;">Cinema Archive Sync</div>` +
        `<div style="color:#9c9ca6;font-size:12px;margin-bottom:4px;">${escapeHtml(reason)}</div>` +
        changes.join('<br>') +
        '<br>Обновление базы на GitHub...'
      );

      const res = await dispatchGitHubSync(inputs);

      if (res.status === 204) {
        saveSyncState({
          watchlistHash: newWatchlistHash,
          ratingsHash: newRatingsHash,
          lastSyncAt: Date.now()
        });
        showToast(
          '<div style="font-weight:600;color:#10b981;margin-bottom:4px;">✓ База Cinema Archive обновлена</div>' +
          changes.join(' &bull; ') +
          '<br><span style="color:#9c9ca6;font-size:12px;">GitHub Pages обновится через ~30 сек.</span>',
          5000,
          '#10b981'
        );
      } else if (res.status === 401) {
        clearToken();
        showToast(
          '<div style="font-weight:600;color:#ef4444;margin-bottom:4px;">✕ Неверный GitHub токен (401)</div>' +
          '<div style="color:#9c9ca6;font-size:12px;">Токен сброшен. Задайте новый через меню Tampermonkey.</div>',
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
      if (pendingResync) {
        const nextReason = pendingReason || 'Повторная проверка изменений';
        pendingResync = false;
        pendingReason = '';
        scheduleFullSync(nextReason, 1200);
      }
    }
  }

  function scheduleFullSync(reason, delayMs = 2200, opts = {}) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      runSync({ reason, ...opts });
    }, delayMs);
  }

  function isImdbListOrRatingMutation(bodyStr, url) {
    const combined = `${url} ${bodyStr}`;
    return /rating|watchlist|listItem|addItem|removeItem|deleteTitleRating|updateTitleRating/i.test(combined);
  }

  // 1. Перехват GraphQL-запросов IMDb (добавление/удаление в Watchlist или смена оценки)
  try {
    const origFetch = pageWin.fetch;
    if (typeof origFetch === 'function') {
      pageWin.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const bodyStr = init && typeof init.body === 'string' ? init.body : '';
        const promise = origFetch.apply(this, arguments);
        if (/graphql/i.test(url) && method === 'POST' && isImdbListOrRatingMutation(bodyStr, url)) {
          promise.then(res => {
            if (res && res.ok) {
              scheduleFullSync('Обнаружено изменение оценки или Watchlist на IMDb', 2000);
            }
          }).catch(() => {});
        }
        return promise;
      };
    }
  } catch (e) {}

  // 2. Резервный перехват кликов по кнопкам оценки и Watchlist в интерфейсе IMDb
  document.addEventListener('click', (e) => {
    const target = e.target && e.target.closest ? e.target.closest(
      '[data-testid*="watchlist"], [data-testid*="Watchlist"], ' +
      '[data-testid*="rating"], [data-testid*="rate"], ' +
      '.ipc-starbar__rating, .ipc-rating-prompt__rating-container button, ' +
      'button[aria-label*="Watchlist"], button[aria-label*="Rate"], ' +
      'button[aria-label*="Remove rating"], .wl-ribbon'
    ) : null;
    if (!target) return;
    const isModalOpener = target.matches('[data-testid="hero-rating-bar__user-rating"] > button, [data-testid="rate-button"]');
    if (!isModalOpener) {
      scheduleFullSync('Обнаружено действие с оценкой или Watchlist', 2600);
    }
  }, true);

  let activeObserver = null;

  // 3. Автоматическая проверка при открытии или изменении /watchlist/ и /ratings/
  function setupPageHooks() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }

    const path = location.pathname;
    const isListPage = /\/user\/[^/]+\/(watchlist|ratings)(\/|$|\?)/i.test(path);
    if (!isListPage) return;

    scheduleFullSync('Проверка списка на странице IMDb', 1800);

    const root = document.querySelector('main') || document.body;
    if (!root) return;

    activeObserver = new MutationObserver((mutations) => {
      const relevant = mutations.some(m => {
        if (m.target && m.target.closest && m.target.closest('#ca-userscript-toast')) return false;
        const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
        return nodes.some(n => {
          if (n.nodeType !== 1) return false;
          if (n.id === 'ca-userscript-toast' || (n.closest && n.closest('#ca-userscript-toast'))) return false;
          return n.matches?.('li.ipc-metadata-list-summary-item, .lister-item') ||
                 Boolean(n.querySelector?.('li.ipc-metadata-list-summary-item, [data-testid*="ratingGroup"]'));
        });
      });
      if (relevant) {
        scheduleFullSync('Обнаружено изменение списка на странице', 2200);
      }
    });
    activeObserver.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupPageHooks, { once: true });
  } else {
    setupPageHooks();
  }

  // Поддержка SPA-переходов внутри IMDb (Next.js router)
  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const current = location.pathname + location.search;
    if (current !== lastPath) {
      lastPath = current;
      setupPageHooks();
    }
  }, 1000);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🔄 Синхронизировать IMDb сейчас', () => {
      tokenPromptDismissed = false;
      runSync({ force: true, reason: 'Ручной запуск из меню' });
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
