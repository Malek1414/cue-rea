// Full-resolution screenshot via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app.
// Pass { maxWidth } to downscale (local models pay per image token).
const { desktopCapturer, screen } = require('electron');

async function captureScreenshot({ maxWidth } = {}) {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  let img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  if (maxWidth && img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: 'good' });
  return img.toDataURL(); // data:image/png;base64,...
}

module.exports = { captureScreenshot };
