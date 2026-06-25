const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, '..');
const svgPath = path.join(baseDir, 'pwa', 'favicon.svg');

const svgBuffer = fs.readFileSync(svgPath);

// Generate 32x32 PNG favicon
sharp(svgBuffer)
  .resize(32, 32)
  .png()
  .toFile(path.join(baseDir, 'pwa', 'favicon.png'))
  .then(() => console.log('✓ favicon.png (32x32)'))
  .catch(err => console.error('PNG error:', err));

// Generate 180x180 Apple touch icon
sharp(svgBuffer)
  .resize(180, 180)
  .png()
  .toFile(path.join(baseDir, 'pwa', 'apple-touch-icon.png'))
  .then(() => console.log('✓ apple-touch-icon.png (180x180)'))
  .catch(err => console.error('Apple icon error:', err));

// Generate 192x192 PWA icon
sharp(svgBuffer)
  .resize(192, 192)
  .png()
  .toFile(path.join(baseDir, 'pwa', 'icon-192.png'))
  .then(() => console.log('✓ icon-192.png'))
  .catch(err => console.error('192 icon error:', err));

// Generate 512x512 PWA icon
sharp(svgBuffer)
  .resize(512, 512)
  .png()
  .toFile(path.join(baseDir, 'pwa', 'icon-512.png'))
  .then(() => console.log('✓ icon-512.png'))
  .catch(err => console.error('512 icon error:', err));
