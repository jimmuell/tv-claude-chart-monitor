import { desktopCapturer } from 'electron';

export async function captureTradingView(): Promise<string> {
  const [windowSources, screenSources] = await Promise.all([
    desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 } }),
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } }),
  ]);

  console.log('[capture] window sources:', windowSources.map((s) => `"${s.name}"`));
  console.log('[capture] screen sources:', screenSources.map((s) => `"${s.name}"`));

  // Match native app or browser tab (e.g. "TradingView", "BTCUSD / TV")
  const tradingViewSource = windowSources.find((source) => {
    const name = source.name.toLowerCase();
    return name.includes('tradingview') || name.includes('/ tv');
  });

  if (tradingViewSource) {
    const buffer = tradingViewSource.thumbnail.toPNG();
    if (buffer.length === 0) {
      throw new Error('TradingView window captured an empty frame. Ensure the window is visible and not minimized.');
    }
    return buffer.toString('base64');
  }

  // Fallback: capture the primary screen
  console.log('[capture] no TradingView window matched — falling back to primary screen capture');
  const primaryScreen = screenSources[0];
  if (!primaryScreen) {
    throw new Error('No TradingView window found and no screen sources available.');
  }
  const buffer = primaryScreen.thumbnail.toPNG();
  if (buffer.length === 0) {
    throw new Error('Screen capture returned an empty frame.');
  }
  return buffer.toString('base64');
}
