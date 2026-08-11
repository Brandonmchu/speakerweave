/* design-sync CSS build: the app's Tailwind config plus the authored preview
   sources, so preview glue classes are generated too. */
const loaded = require('./tailwind.config.js')
const base = loaded.default ?? loaded
module.exports = {
  ...base,
  // The app scopes utilities under #root (important: '#root') to beat Radix
  // inline styles; previews and Claude Design mount elsewhere, so the DS
  // stylesheet must be unscoped.
  important: false,
  content: ['./src/**/*.{ts,tsx}', '../.design-sync/previews/**/*.tsx'],
}
