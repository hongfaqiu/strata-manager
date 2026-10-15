# Website animation dependencies

GSAP and ScrollTrigger are pinned to **3.13.0** and served locally, so the page does not need a third-party CDN at runtime.

- `gsap.min.js`: https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js
- `ScrollTrigger.min.js`: https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/ScrollTrigger.min.js
- Copyright 2025 GreenSock. Original copyright and license headers are retained in both files.
- License: https://gsap.com/standard-license/

The page works without the animation scripts. Reduced-motion preferences disable all GSAP timelines and CSS transitions.
