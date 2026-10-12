// Rasterizes assets/*.svg into the PNGs the tray and toasts use.
// White variants go on dark surfaces, black ones on light.
// Run with: npx electron tools/render-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const OUT = [
  { svg: 'spiky-cloud-white-small.svg', file: 'tray-white-16.png', size: 16 },
  { svg: 'spiky-cloud-white-small.svg', file: 'tray-white-32.png', size: 32 },
  { svg: 'spiky-cloud-black-small.svg', file: 'tray-black-16.png', size: 16 },
  { svg: 'spiky-cloud-black-small.svg', file: 'tray-black-32.png', size: 32 },
  { svg: 'spiky-cloud-white-small.svg', file: 'toast-white-256.png', size: 256 },
  { svg: 'spiky-cloud-black.svg', file: 'toast-black-256.png', size: 256 },
  // app/installer icon: needs its own dark tile so it reads on light Explorer too
  { svg: 'spiky-cloud-white-small.svg', file: 'app-256.png', size: 256, tile: '#141414' },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const o of OUT) {
    const svg = fs.readFileSync(path.join(ASSETS, o.svg), 'utf8');
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const png = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const s = ${o.size}, c = document.querySelector('canvas');
        c.width = s; c.height = s;
        const g = c.getContext('2d');
        g.clearRect(0, 0, s, s);
        const tile = ${JSON.stringify(o.tile || '')};
        const pad = tile ? s * 0.14 : 0;
        if (tile) { g.fillStyle = tile; g.beginPath(); g.roundRect(0, 0, s, s, s * 0.22); g.fill(); }
        const w = s - pad * 2, h = w * 260 / 416;  // art is 416x260: fit width, center vertically
        g.drawImage(img, pad, (s - h) / 2, w, h);
        resolve(c.toDataURL('image/png'));
      };
      img.src = ${JSON.stringify(url)};
    })`);
    fs.writeFileSync(path.join(ASSETS, o.file), Buffer.from(png.split(',')[1], 'base64'));
    console.log('wrote', o.file);
  }
  app.quit();
});
