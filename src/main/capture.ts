import { desktopCapturer } from 'electron';

export async function captureTradingView(): Promise<string> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1920, height: 1080 },
  });

  // Uses the first matching window if multiple TradingView windows are open
  const tradingViewSource = sources.find((source) =>
    source.name.toLowerCase().includes('tradingview')
  );

  if (!tradingViewSource) {
    throw new Error(
      'No TradingView window found. Please open TradingView in a browser.'
    );
  }

  const buffer = tradingViewSource.thumbnail.toPNG();
  if (buffer.length === 0) {
    throw new Error('TradingView window captured an empty frame. Ensure the window is visible and not minimized.');
  }
  return buffer.toString('base64');
}
