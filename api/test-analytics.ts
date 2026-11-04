import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/js/analytics.js', import.meta.url), 'utf8');

test('analytics waits for consent and sends only allowlisted pages and feature events', () => {
  const values = new Map<string, string>();
  const scripts: any[] = [];
  const prompt = { hidden: true };
  const ctx: any = vm.createContext({
    console,
    location: { origin: 'https://books.example' },
    document: {
      title: 'Bookkeeper',
      referrer: 'https://campaign.example/start?email=private@example.com',
      getElementById: (id: string) => id === 'analytics-consent' ? prompt : null,
      createElement: () => ({}),
      head: { append: (script: any) => scripts.push(script) },
    },
    URL,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    window: {},
  });
  vm.runInContext(source, ctx);
  const analytics = ctx.ProductAnalytics;

  analytics.init({ key: 'phc-public', host: 'https://eu.i.posthog.com' });
  assert.equal(prompt.hidden, false);
  analytics.page('home');
  analytics.event('entry_created', { entry_type: 'sale' });
  assert.equal(ctx.window.posthog, undefined, 'no SDK loads before consent');

  analytics.choose('accepted');
  const client = ctx.window.posthog;
  assert.equal(prompt.hidden, true);
  assert.equal(scripts[0].src, 'https://eu-assets.i.posthog.com/static/array.js');
  const events = () => client.filter((call: any[]) => call[0] === 'capture');
  assert.deepEqual(JSON.parse(JSON.stringify(events()[0])), ['capture', '$pageview', {
    $current_url: 'https://books.example/#/home',
    $pathname: '/#/home',
    $referrer: 'https://campaign.example',
    $referring_domain: 'campaign.example',
    $title: 'Bookkeeper',
  }]);

  ctx.location.hash = '#/people/private-record-id';
  analytics.page('people');
  analytics.event('entry_created', { entry_type: 'sale' });
  analytics.event('entry_created', { entry_type: 'private-value' });
  analytics.event('not_allowlisted', { note: 'sensitive' });
  const sent = JSON.parse(JSON.stringify(events().slice(1)));
  assert.deepEqual(sent[0], ['capture', '$pageview', {
    $current_url: 'https://books.example/#/people',
    $pathname: '/#/people',
    $referrer: 'https://campaign.example',
    $referring_domain: 'campaign.example',
    $title: 'Bookkeeper',
  }]);
  assert.deepEqual(sent[1], ['capture', 'entry_created', {
    $current_url: 'https://books.example/#/people',
    $pathname: '/#/people',
    $referrer: 'https://campaign.example',
    $referring_domain: 'campaign.example',
    entry_type: 'sale',
  }]);
  assert.equal(JSON.stringify(sent).includes('private-record-id'), false);
  assert.equal(JSON.stringify(sent).includes('private@example.com'), false);

  analytics.preferences();
  assert.equal(prompt.hidden, false);
  analytics.choose('declined');
  analytics.event('invite_created');
  assert.equal(values.get('bk-analytics-consent'), 'declined');
  assert.equal(events().length, 3);
});

test('analytics remains disabled without a configured PostHog host or key', () => {
  const prompt = { hidden: true };
  const ctx: any = vm.createContext({
    document: { getElementById: () => prompt },
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {},
  });
  vm.runInContext(source, ctx);
  ctx.ProductAnalytics.init(null);
  ctx.ProductAnalytics.init({ key: 'phc-public', host: 'https://invalid.example' });
  assert.equal(prompt.hidden, true);
  assert.equal(ctx.window.posthog, undefined);
});
