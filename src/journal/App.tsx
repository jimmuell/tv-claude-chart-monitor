import React, { useEffect, useState } from 'react';
import { Today } from './pages/Today';
import { TradeList } from './pages/TradeList';
import { Stats } from './pages/Stats';
import { Analysis } from './pages/Analysis';
// Config will be wired in next task — no import yet

type RouteKey = '#/' | '#/trades' | '#/stats' | '#/analysis' | '#/config';

const ROUTES: Record<RouteKey, React.ComponentType> = {
  '#/':         Today,
  '#/trades':   TradeList,
  '#/stats':    Stats,
  '#/analysis': Analysis,
  '#/config':   Today,   // temporary stub until Config page exists
};

function normalizeHash(hash: string): RouteKey {
  if (hash === '#/trades')   return '#/trades';
  if (hash === '#/stats')    return '#/stats';
  if (hash === '#/analysis') return '#/analysis';
  if (hash === '#/config')   return '#/config';
  return '#/';
}

export function App() {
  const [route, setRoute] = useState<RouteKey>(() =>
    normalizeHash(window.location.hash || '#/')
  );

  useEffect(() => {
    const handler = () => setRoute(normalizeHash(window.location.hash));
    window.addEventListener('hashchange', handler);
    // Ensure URL reflects current route on mount
    if (!window.location.hash) window.location.hash = '#/';
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const Page = ROUTES[route] ?? Today;

  const navItems: { label: string; href: RouteKey }[] = [
    { label: 'Today',    href: '#/' },
    { label: 'Trades',   href: '#/trades' },
    { label: 'Stats',    href: '#/stats' },
    { label: 'Analysis', href: '#/analysis' },
    { label: 'Config',   href: '#/config' },
  ];

  return (
    <>
      <nav className="nav">
        <span className="nav-brand">Trade Journal</span>
        {navItems.map(item => (
          <a
            key={item.href}
            href={item.href}
            className={`nav-link${route === item.href ? ' active' : ''}`}
            onClick={e => {
              e.preventDefault();
              window.location.hash = item.href;
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <Page />
    </>
  );
}
