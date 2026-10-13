# System Language Packs Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Preserve the unrelated dirty primary checkout.

**Goal:** Add installer and first-launch language choice, system detection and eight additional i18next language packs.

**Architecture:** Pure core locale resolution and backwards compatible saved preference migration; read-only native locale command; NSIS language list and quiet update hooks; frontend first-launch choice and shared-settings selector.

**Tech Stack:** Tauri 2 / NSIS / Rust Win32 / React / i18next / Vitest.

### Task 1: locale rules and settings
- [x] Add packages/core/tests/languages.test.ts for POSIX and BCP47 tags, Chinese scripts, unsupported/C fallback, explicit preferences, legacy settings and installer preference precedence; run pnpm --filter @strata-manager/core test -- languages.test.ts and confirm missing feature failure.
- [x] Implement packages/core/src/languages.ts and AppSettings languagePreference, export through index.ts; rerun tests.

### Task 2: native and installer (agent)
- [x] Add apps/desktop/src-tauri/src/system_locale.rs with pure OS-locale priority tests and read-only command; register in lib.rs, add Win32_Globalization feature.
- [x] Configure ten NSIS languages and installer selector with windows/installer-hooks.nsh that skips silent/passive/update language dialogs; read existing Installer Language only for new app preferences.

### Task 3: language resources (agents)
- [x] Translate all existing 677 i18next English dictionary keys for ja/ko/de/fr/es/pt/ru; convert and review zh-TW. Preserve all interpolation markers.
- [x] Add independent JSON key/interpolation checks and dynamic resources registration with English fallback.

### Task 4: frontend integration
- [x] Extend locale types without changing existing two-language semantic comparisons; use core normalization after store/native locale read. First-launch LanguageSetupDialog chooses system or native language labels and persists only after explicit confirmation; settings selector applies and saves preference.
- [x] Native monitor/tray use English fallback for all non-simplified-Chinese locales.
- [x] Verify typecheck, frontend/core suites and build, native checks and real component browser choice/reload. Record source-level vs installer/desktop acceptance limits.
