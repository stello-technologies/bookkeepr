// Copies the sign-in library and the Figtree font out of node_modules into web/vendor, so the app never needs a CDN.
// Run after `npm install`: npm run vendor
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('web/vendor/fonts', { recursive: true });
cpSync('node_modules/@auth0/auth0-spa-js/dist/auth0-spa-js.production.js', 'web/vendor/auth0-spa-js.production.js');
const faces = [];
for (const w of [400, 500, 600, 700, 800]) for (const subset of ['latin', 'latin-ext']) { // latin-ext holds the naira sign
  const name = `figtree-${subset}-${w}-normal.woff2`;
  cpSync(`node_modules/@fontsource/figtree/files/${name}`, `web/vendor/fonts/${name}`);
  const range = subset === 'latin'
    ? 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
    : 'U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
  faces.push(`@font-face { font-family: 'Figtree'; font-style: normal; font-weight: ${w}; font-display: swap; src: url(/vendor/fonts/${name}) format('woff2'); unicode-range: ${range}; }`);
}
writeFileSync('web/css/fonts.css', faces.join('\n') + '\n');
console.log('vendor files ready');
