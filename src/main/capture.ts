import { desktopCapturer } from 'electron';

export async function captureTradeView(): Promise<string> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1920, height: 1080 },
  });

  const tradingViewSource = sources.find((source) =>
    source.name.toLowerCase().includes('tradingview')
  );

  if (!tradingViewSource) {
    throw new Error(
      'No TradingView window found. Please open TradingView in a browser.'
    );
  }

  const buffer = tradingViewSource.thumbnail.toPNG();
  return buffer.toString('base64');
}
