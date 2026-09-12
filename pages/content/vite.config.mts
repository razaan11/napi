import { resolve } from 'node:path';
import { makeEntryPointPlugin } from '@extension/hmr';
import { isDev, withPageConfig } from '@extension/vite-config';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';

const rootDir = resolve(__dirname);
const srcDir = resolve(rootDir, 'src');

export default withPageConfig({
  resolve: {
    alias: {
      '@src': srcDir,
    },
  },
  publicDir: resolve(rootDir, 'public'),
  // napi: a content script has no <link> tag to load a separate CSS file
  // from — manifest.json's content_scripts here only declares `js`, and
  // that was true before this change too (the pre-existing _content.css
  // output was never wired up either). Inline Driver.js's CSS (and any
  // future content-script styles) directly into the JS bundle instead, so
  // it applies via a runtime <style> tag on every page regardless of
  // manifest wiring — the standard fix for extension content scripts.
  plugins: [isDev && makeEntryPointPlugin(), cssInjectedByJsPlugin()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['iife'],
      name: 'ContentScript',
      fileName: 'index',
    },
    outDir: resolve(rootDir, '..', '..', 'dist', 'content'),
  },
});
