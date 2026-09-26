/* Task 15: framework-free invitation landing page.
 *
 * Ownership: everything the invitee's BROWSER does before the store
 * hand-off. Loaded as a plain script (no modules, no bundler) from
 * index.html after runtime-config.js.
 *
 * Safety rules enforced here (and asserted by scripts/invite-web.test.mjs):
 * - The invitation token is NEVER inserted as HTML. Only `textContent`
 *   assignments touch the DOM — no innerHTML/outerHTML/insertAdjacentHTML
 *   — and the token must match the server contract (32 lowercase hex)
 *   before it is shown or encoded anywhere.
 * - iOS: the clipboard write starts only inside the user's own tap on an
 *   HTTPS page, and we navigate to the App Store ONLY after the copy
 *   resolved. A failed copy never fakes success: it shows a retry button
 *   and how to reopen the link.
 * - Android: the token is URL-encoded into the Google Play `referrer`
 *   value as `invitation=<enc>` — the exact parameter Task 14's install
 *   referrer parser reads (and the only one it reads).
 * - Missing/invalid runtime config or an unreadable token renders an
 *   explanatory message; the page never half-renders.
 *
 * Pure helpers are exposed on `globalThis.__INVITE_WEB_API__` so
 * node --test can exercise the shipped code in a vm sandbox.
 */
(function () {
  'use strict';

  /** Server token contract (Task 6 / Task 14): 32 lowercase hex chars. */
  var TOKEN_RE = /^[0-9a-f]{32}$/;
  var CONFIG_KEY = '__INVITE_RUNTIME_CONFIG__';

  var MESSAGES = {
    configMissing:
      '招待ページの設定が読み込めていません (runtime-config.js)。サイトの管理者に確認してください。招待リンクをもう一度開き直してください。',
    configInvalid:
      '招待ページの設定が不正です。サイトの管理者に確認してください。招待リンクをもう一度開き直してください。',
    tokenInvalid:
      '招待リンクを読み取れませんでした。元の招待リンクを開き直してください。うまくいかない場合は、招待した相手のUser IDで探せます。',
    copyFailedTitle: 'リンクをコピーできなかったため、App Storeへは進みませんでした。',
    copyFailedHelp:
      '成功を装って進めません。下のボタンでもう一度試してください。それでもダメな場合は、下に表示した招待リンクをブラウザのアドレスバーで開き直してください。',
    noClipboardTitle: 'このブラウザではクリップボードへコピーできません。',
    noClipboardHelp:
      'HTTPSで開いているか確認し、再度試してください。うまくいかない場合は、下に表示した招待リンクをブラウザのアドレスバーで開いてください。',
    otherPlatform: undefined, // uses the static copy from index.html
    testBadge:
      'このページはテスト用の設定で生成された出力です。公開してはいけません。',
  };

  /** @type {Record<string, unknown>} */
  var api = {
    TOKEN_RE: TOKEN_RE,
    MESSAGES: MESSAGES,
    extractToken: extractToken,
    isValidToken: isValidToken,
    buildInviteUrl: buildInviteUrl,
    buildPlayStoreUrl: buildPlayStoreUrl,
    classifyPlatform: classifyPlatform,
    validateRuntimeConfig: validateRuntimeConfig,
    loadRuntimeConfig: loadRuntimeConfig,
  };
  // Stable, documented handle for tests (scripts/invite-web.test.mjs).
  globalThis.__INVITE_WEB_API__ = api;

  /** True for the server's 32-hex token. Anything else is rejected. */
  function isValidToken(value) {
    return typeof value === 'string' && TOKEN_RE.test(value);
  }

  /**
   * Pulls the token out of a path (`/invitation/<32hex>` with optional
   * trailing slash, query or fragment stripped first). Returns null for
   * anything else — including malformed tokens, which the UI explains.
   */
  function extractToken(pathname) {
    if (typeof pathname !== 'string' || pathname === '') return null;
    var path = pathname.split(/[?#]/)[0];
    var match = /\/invitation\/([0-9a-f]{32})\/?$/.exec(path);
    if (match === null) return null;
    return match[1];
  }

  /**
   * The shareable link `<origin>/invitation/<token>` — the same shape
   * Task 14's `buildInvitationUrl` produces. Throws on a bad token or a
   * non-https origin so a malformed value can never be shared.
   */
  function buildInviteUrl(origin, token) {
    if (!isValidToken(token)) throw new Error('invalid invitation token');
    if (typeof origin !== 'string' || !/^https:\/\/[^/\s]+$/.test(origin.replace(/\/+$/, ''))) {
      throw new Error('invalid invite origin');
    }
    return origin.replace(/\/+$/, '') + '/invitation/' + token;
  }

  /**
   * Google Play URL carrying the token in the install referrer:
   * `…&referrer=invitation%3D<enc>` — after Play's one URL-decode the
   * referrer value is exactly `invitation=<enc>`, which Task 14's parser
   * decodes to the token (and ignores every other parameter for).
   */
  function buildPlayStoreUrl(playStoreUrl, token) {
    if (!isValidToken(token)) throw new Error('invalid invitation token');
    if (typeof playStoreUrl !== 'string' || !/^https:\/\//.test(playStoreUrl)) {
      throw new Error('invalid play store url');
    }
    var referrerValue = 'invitation=' + encodeURIComponent(token);
    var separator = playStoreUrl.indexOf('?') === -1 ? '?' : '&';
    return playStoreUrl + separator + 'referrer=' + encodeURIComponent(referrerValue);
  }

  /** Coarse platform classification for which hand-off to show. */
  function classifyPlatform(userAgent, maxTouchPoints) {
    var ua = typeof userAgent === 'string' ? userAgent : '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    // iPadOS 13+ reports a Macintosh UA; touch points disambiguate.
    if (/Macintosh/i.test(ua) && Number(maxTouchPoints) > 1) return 'ios';
    return 'other';
  }

  /**
   * Validates the generated runtime config. Returns `{ok:true, config}`
   * or `{ok:false, reason:'missing'|'invalid'}` — the caller renders the
   * matching explanation instead of a broken page.
   */
  function validateRuntimeConfig(config) {
    if (config === null || config === undefined || typeof config !== 'object') {
      return { ok: false, reason: 'missing' };
    }
    var origin = config.origin;
    if (typeof origin !== 'string' || !/^https:\/\/[^/\s]+$/.test(origin.replace(/\/+$/, ''))) {
      return { ok: false, reason: 'invalid' };
    }
    if (
      typeof config.iosAppStoreUrl !== 'string' ||
      !/^https:\/\/apps\.apple\.com\//.test(config.iosAppStoreUrl)
    ) {
      return { ok: false, reason: 'invalid' };
    }
    if (
      typeof config.androidPlayStoreUrl !== 'string' ||
      !/^https:\/\/play\.google\.com\//.test(config.androidPlayStoreUrl)
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, config: config };
  }

  /** Reads `window.__INVITE_RUNTIME_CONFIG__` (generated by the build). */
  function loadRuntimeConfig() {
    if (typeof window === 'undefined') return null;
    return window[CONFIG_KEY] === undefined ? null : window[CONFIG_KEY];
  }

  // -------------------------------------------------------------------------
  // DOM wiring. Only runs in a browser (tests import the API above without
  // a document) and only ever writes via textContent / href / hidden.
  // -------------------------------------------------------------------------

  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
    return;
  }

  function el(id) {
    return document.getElementById(id);
  }
  function setText(id, text) {
    var node = el(id);
    if (node) node.textContent = text;
  }
  function show(id) {
    var node = el(id);
    if (node) node.hidden = false;
  }
  function hide(id) {
    var node = el(id);
    if (node) node.hidden = true;
  }

  var state = { config: null, token: null, inviteUrl: null, platform: 'other' };

  function renderStatus(message) {
    hide('invite-panel');
    setText('invite-status', message);
    show('invite-status');
  }

  function renderIosFailure(titleId, helpId) {
    setText('invite-ios-failure-title', MESSAGES[titleId]);
    setText('invite-ios-failure-help', MESSAGES[helpId]);
    // "How to reopen the link": the URL as plain text (long-pressable in
    // Safari) — never an anchor the page silently navigates for the user.
    setText('invite-reopen-link', state.inviteUrl || '');
    show('invite-ios-failure');
  }

  /** iOS hand-off: clipboard write inside the user's tap → App Store. */
  function openAppStore() {
    if (state.inviteUrl === null) return;
    hide('invite-ios-failure');
    var nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') {
      // Insecure context / unsupported browser: explain, never fake success.
      renderIosFailure('noClipboardTitle', 'noClipboardHelp');
      return;
    }
    var navLocation =
      typeof window !== 'undefined' && window.location ? window.location : null;
    var write;
    try {
      // The write STARTS here — inside this click, i.e. the user's own
      // HTTPS gesture. Never on page load, never without a tap.
      write = nav.clipboard.writeText(state.inviteUrl);
    } catch (error) {
      renderIosFailure('copyFailedTitle', 'copyFailedHelp');
      return;
    }
    Promise.resolve(write)
      .then(function () {
        // Success ONLY: navigate to the App Store after the copy landed.
        if (navLocation && typeof navLocation.assign === 'function') {
          navLocation.assign(state.config.iosAppStoreUrl);
        }
      })
      .catch(function () {
        renderIosFailure('copyFailedTitle', 'copyFailedHelp');
      });
  }

  function wire(config, token) {
    state.config = config;
    state.token = token;
    state.inviteUrl = buildInviteUrl(config.origin, token);
    state.platform = classifyPlatform(
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
      typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
    );

    setText('invite-token', token); // textContent — never HTML
    hide('invite-status');

    if (state.platform === 'ios') {
      hide('invite-android-link');
      hide('invite-other-platform');
      show('invite-ios-button');
      var iosButton = el('invite-ios-button');
      if (iosButton) iosButton.addEventListener('click', openAppStore);
      var retry = el('invite-ios-retry');
      if (retry) retry.addEventListener('click', openAppStore);
    } else if (state.platform === 'android') {
      hide('invite-ios-button');
      hide('invite-other-platform');
      var link = el('invite-android-link');
      if (link) {
        // Token URL-encoded into the Play referrer (see buildPlayStoreUrl).
        link.href = buildPlayStoreUrl(config.androidPlayStoreUrl, token);
        link.addEventListener('click', function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof window !== 'undefined' && window.location) {
            window.location.assign(link.href);
          }
        });
      }
      show('invite-android-link');
    } else {
      hide('invite-ios-button');
      hide('invite-android-link');
      setText('invite-url', state.inviteUrl); // textContent — never HTML
      show('invite-other-platform');
    }

    if (config.testOnly === true) {
      setText('invite-test-badge', MESSAGES.testBadge);
      show('invite-test-badge');
    }

    show('invite-panel');
  }

  function start() {
    var validated = validateRuntimeConfig(loadRuntimeConfig());
    if (!validated.ok) {
      renderStatus(validated.reason === 'missing' ? MESSAGES.configMissing : MESSAGES.configInvalid);
      return;
    }
    var token = extractToken(
      typeof window !== 'undefined' && window.location ? window.location.pathname : '',
    );
    if (token === null) {
      renderStatus(MESSAGES.tokenInvalid);
      return;
    }
    wire(validated.config, token);
  }

  start();
})();
