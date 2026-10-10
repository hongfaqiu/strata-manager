# Official Strata UI assets

Source: official Strata `serve/web` at revision `fb58e0dbc8399662c0e47c76578c6e878b14f6cf`, copied on 2026-10-10. Upstream: <https://github.com/Niko1221/Strata/tree/fb58e0dbc8399662c0e47c76578c6e878b14f6cf/serve/web>.

- `components.css`, `app.css`, and `sprite.svg` retain the upstream source bytes.
- `tokens.css` preserves upstream tokens; its Outfit URLs are adjusted from `fonts/...` to `../fonts/...` for this module directory. It is not a byte-identical copy.
- `scoped-components.css` and `scoped-app.css` are generated from official source by adding `.official-surface` to selectors (HTML/body root selectors map to that surface, and `main` maps to `.official-main`). Property values and media breakpoints are retained. The scoped files prevent generic official layout rules from changing management views.
- `api-monitor.css` extracts and scopes the inline style from official `monitor.html` to `.api-monitor-page`.
- `../official-pages.css` contains integration corrections and the user-requested manager layout. Official visual components and content are retained, while navigation moves into a collapsible sidebar, history into the chat page, and service configuration into its own page. These structural changes follow the latest user request.

MIT license: `LICENSE.strata`. Outfit font files live in `../fonts/`, with SIL Open Font License 1.1 in `../fonts/OFL.txt`. Both licenses are bundled in the desktop app. No remote font requests are required.

Element mapping and the explicit manager-shell exceptions are recorded in `../../../../docs/OFFICIAL_UI_PARITY.md`. Source mapping is not a claim of pixel-perfect visual verification.
