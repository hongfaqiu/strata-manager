# Website animation

The site has no animation library: entrances and reveals are CSS transitions triggered by IntersectionObserver, and the stage lift uses CSS scroll-driven animation where supported. Reduced-motion preferences disable them.

# Website fonts

`fonts/Geist.woff2` and `fonts/GeistMono.woff2` are Latin/number subsets of the Geist and Geist Mono variable fonts (https://github.com/vercel/geist-font), converted to WOFF2 with fontTools. Chinese text uses the system CJK sans. License: SIL Open Font License 1.1, see `fonts/OFL.txt`.
