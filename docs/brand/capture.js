async (page) => {
  const context = await page.context().browser().newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    serviceWorkers: 'block',
  });
  const hero = await context.newPage();
  const errors = [];
  hero.on('pageerror', error => errors.push(String(error)));
  hero.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await hero.goto('http://127.0.0.1:1439/docs/brand/product-cover.html');
    await hero.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
      const background = new Image();
      background.src = 'hero-background.webp';
      await background.decode();
    });
    const details = await hero.evaluate(() => ({
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      fontLoaded: document.fonts.check('72px Outfit'),
      overflow: document.documentElement.scrollWidth > innerWidth,
      imagesLoaded: [...document.images].every(image => image.complete && image.naturalWidth > 0),
    }));
    if (errors.length || details.overflow || !details.fontLoaded || !details.imagesLoaded) {
      throw new Error(JSON.stringify({ details, errors }));
    }
    await hero.screenshot({ path: 'output/playwright/product-cover.png', scale: 'device', animations: 'disabled' });
    return { ...details, errors };
  } finally { await context.close(); }
}
