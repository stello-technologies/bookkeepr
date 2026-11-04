'use strict';
/* Optional, consent-based PostHog tracking. Only fixed page names and feature events leave the browser. */
(function () {
  const CONSENT_KEY = 'bk-analytics-consent';
  const pages = new Set(['login', 'home', 'entries', 'people', 'inventory', 'analytics']);
  const entryTypes = new Set(['sale', 'purchase', 'opening_stock', 'expense', 'payment_in', 'payment_out']);
  let config = null, initialized = false, currentPage = null, trackedPage = null, consentOverride = null;

  function consent() {
    if (consentOverride !== null) return consentOverride;
    try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
  }

  function saveConsent(value) {
    consentOverride = value;
    try { localStorage.setItem(CONSENT_KEY, value); } catch { /* preference lasts for this page only */ }
  }

  function showPrompt() {
    const prompt = document.getElementById('analytics-consent');
    if (prompt) prompt.hidden = false;
  }

  function hidePrompt() {
    const prompt = document.getElementById('analytics-consent');
    if (prompt) prompt.hidden = true;
  }

  function loadSdk() {
    if (initialized || !config) return;
    initialized = true;
    const posthog = window.posthog = window.posthog || [];
    posthog._i = posthog._i || [];
    posthog.init = posthog.init || function (key, options, name) {
      const target = name ? (posthog[name] = posthog[name] || []) : posthog;
      target.people = target.people || [];
      target.toString = function (stub) { return `posthog${name ? `.${name}` : ''}${stub ? ' (stub)' : ''}`; };
      target.people.toString = function () { return `${target.toString(1)}.people (stub)`; };
      const methods = 'capture identify alias group reset opt_in_capturing opt_out_capturing get_distinct_id get_session_id'.split(' ');
      methods.forEach((method) => {
        target[method] = function () { target.push([method, ...arguments]); };
      });
      posthog._i.push([key, options, name]);
    };

    const options = {
      api_host: config.host,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      person_profiles: 'never',
      respect_dnt: true,
      ip: false,
    };
    posthog.init(config.key, options);
    if (!posthog.__SV) {
      posthog.__SV = 1;
      const host = config.host.replace('.i.posthog.com', '-assets.i.posthog.com');
      const script = document.createElement('script');
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.src = `${host}/static/array.js`;
      script.onerror = () => console.warn('PostHog analytics SDK could not be loaded');
      document.head.append(script);
    }
  }

  function capture(event, properties = {}) {
    if (consent() !== 'accepted' || !initialized || typeof window.posthog?.capture !== 'function') return;
    const pageName = currentPage || 'login';
    let referrer = '';
    try { if (document.referrer) referrer = new URL(document.referrer).origin; } catch { /* do not send an unparseable referrer */ }
    window.posthog.capture(event, {
      $current_url: `${location.origin}/#/${pageName}`,
      $pathname: `/#/${pageName}`,
      $referrer: referrer,
      $referring_domain: referrer ? new URL(referrer).hostname : '',
      ...properties,
    });
  }

  function page(name) {
    if (!pages.has(name) || currentPage === name) return;
    currentPage = name;
    if (consent() === 'accepted') {
      capture('$pageview', { $title: document.title });
      trackedPage = name;
    }
  }

  function init(settings) {
    const host = settings?.host;
    if (!settings?.key || !['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(host)) return;
    config = { key: settings.key, host };
    if (consent() === 'accepted') loadSdk();
    else if (consent() !== 'declined') showPrompt();
  }

  function choose(value) {
    saveConsent(value);
    hidePrompt();
    if (value === 'accepted') {
      loadSdk();
      if (initialized && typeof window.posthog?.opt_in_capturing === 'function') window.posthog.opt_in_capturing();
      if (currentPage && trackedPage !== currentPage) {
        capture('$pageview', { $title: document.title });
        trackedPage = currentPage;
      }
    } else if (initialized && typeof window.posthog?.opt_out_capturing === 'function') {
      window.posthog.opt_out_capturing();
    }
  }

  function preferences() {
    if (!config) return;
    if (consent() === 'accepted' && initialized && typeof window.posthog?.opt_out_capturing === 'function') window.posthog.opt_out_capturing();
    showPrompt();
  }

  globalThis.ProductAnalytics = {
    init,
    page,
    event(name, properties) {
      if (name === 'entry_created' && entryTypes.has(properties?.entry_type)) {
        capture(name, { entry_type: properties.entry_type });
      } else if (['entry_form_opened', 'invite_created', 'person_created', 'item_created'].includes(name)) {
        capture(name);
      }
    },
    choose,
    preferences,
  };
})();
