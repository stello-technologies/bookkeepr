# Bookkeepr 📒

- Bookkeeping software for SME.

## Optional audience and usage analytics

The app can send consent-based, pseudonymous audience and feature-usage events to PostHog. Create a PostHog project, then set these server environment variables:

- `POSTHOG_KEY`: the project's browser/ingestion key (safe to expose to browsers; never use a personal or admin API key).
- `POSTHOG_HOST`: `https://us.i.posthog.com` or `https://eu.i.posthog.com`, matching the project region. If omitted, the US host is used.

Analytics is disabled when `POSTHOG_KEY` is unset. When enabled, visitors can allow or decline tracking, and change their choice from the sign-in screen or Account panel. After opt-in, the browser SDK sends page views for the login screen and app sections, plus entry-form opens, successful entry creation (broad entry type only), successful person/item creation, and successful staff invites. Autocapture, session recording, and person profiles are disabled; the app does not identify visitors with Auth0 IDs.

Never add names, amounts, notes, search text, record IDs, or other bookkeeping contents to analytics events. Review applicable consent, privacy-notice, and retention requirements before enabling analytics for production users.
