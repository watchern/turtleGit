const path = require('path');
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const dev = !production;

async function main() {
  const extension = await esbuild.context({
    entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: path.join(__dirname, 'dist', 'extension.js'),
    external: ['vscode'],
    sourcemap: dev,
    minify: production,
    logLevel: 'info',
  });

  const webview = await esbuild.context({
    entryPoints: [path.join(__dirname, 'webview', 'main.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    outfile: path.join(__dirname, 'dist', 'webview', 'main.js'),
    loader: { '.css': 'css' },
    sourcemap: dev,
    minify: production,
    logLevel: 'info',
  });

  if (watch) {
    await Promise.all([extension.watch(), webview.watch()]);
    console.log('[turtlegit] watching...');
  } else {
    await Promise.all([extension.rebuild(), webview.rebuild()]);
    await Promise.all([extension.dispose(), webview.dispose()]);
    console.log('[turtlegit] build done');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
