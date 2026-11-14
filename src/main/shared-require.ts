import path from 'path';

/**
 * Loads one of the shared CommonJS modules in src/shared, which tsc deliberately
 * does not compile. Resolved from __dirname rather than Electron's app.getAppPath()
 * so modules that use it stay testable under plain node.
 *
 * At runtime __dirname is <app>/dist/main/main, so three levels up is the app root
 * in both the dev tree and the packaged asar.
 */
export function sharedModule<T = any>(fileName: string): T {
  return require(path.join(__dirname, '..', '..', '..', 'src', 'shared', fileName));
}
