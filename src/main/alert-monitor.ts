import { Notification, shell } from 'electron';

interface PriceAlert {
  price:    number;
  label:    string;
  symbol:   string;
  lastSide: 'above' | 'below' | null;
}

// key: `${symbol}:${price}`
const alerts = new Map<string, PriceAlert>();

export function registerAlert(price: number, label: string, symbol: string): void {
  const key = `${symbol}:${price}`;
  alerts.set(key, { price, label, symbol, lastSide: null });
}

export function checkCrossings(currentPrice: number, symbol: string): void {
  const fired: string[] = [];

  for (const [key, alert] of alerts) {
    if (alert.symbol !== symbol) continue;

    const side: 'above' | 'below' = currentPrice >= alert.price ? 'above' : 'below';

    if (alert.lastSide !== null && alert.lastSide !== side) {
      shell.beep();
      if (Notification.isSupported()) {
        new Notification({
          title:  'Level Alert',
          body:   `${alert.label} @ ${alert.price.toFixed(2)} crossed`,
          silent: true,
        }).show();
      }
      fired.push(key);
    }

    alert.lastSide = side;
  }

  for (const key of fired) alerts.delete(key);
}

export function clearAlertForPrice(price: number): void {
  for (const [key, alert] of alerts) {
    if (alert.price === price) alerts.delete(key);
  }
}

export function getArmedPrices(): Set<number> {
  return new Set([...alerts.values()].map(a => a.price));
}

export function clearAlertsForSymbol(symbol: string): void {
  for (const [key, alert] of alerts) {
    if (alert.symbol === symbol) alerts.delete(key);
  }
}
