// Rasterizes assets/*.svg into the PNGs the tray and toasts use.
// Run with: npx electron tools/render-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const OUT = [
  { svg: 'spiky-cloud-icon.svg', file: 'tray-16.png', size: 16, color: '#ffffff' },
  { svg: 'spiky-cloud-icon.svg', file: 'tray-32.png', size: 32, color: '#ffffff' },
  { svg: 'spiky-cloud.svg', file: 'icon-256.png', size: 256 },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const o of OUT) {
    let svg = fs.readFileSync(path.join(ASSETS, o.svg), 'utf8');
    if (o.color) svg = svg.replace(/currentColor/g, o.color);
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const png = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const s = ${o.size}, c = document.querySelector('canvas');
        c.width = s; c.height = s;
        const g = c.getContext('2d');
        g.clearRect(0, 0, s, s);
        const w = s, h = s * img.height / img.width;  // art is wide: fit width, center vertically
        g.drawImage(img, 0, (s - h) / 2, w, h);
        resolve(c.toDataURL('image/png'));
      };
      img.src = ${JSON.stringify(url)};
    })`);
    fs.writeFileSync(path.join(ASSETS, o.file), Buffer.from(png.split(',')[1], 'base64'));
    console.log('wrote', o.file);
  }
  app.quit();
});
