const esbuild = require('esbuild');

const nodeCfg = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
};

const webviewCfg = {
  entryPoints: ['src/panel/webview.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/webview.js',
  sourcemap: true,
};

async function main() {
  const watch = process.argv.includes('--watch');
  if (watch) {
    const a = await esbuild.context(nodeCfg);
    const b = await esbuild.context(webviewCfg);
    await Promise.all([a.watch(), b.watch()]);
    console.log('watching...');
  } else {
    await esbuild.build(nodeCfg);
    await esbuild.build(webviewCfg);
    console.log('built dist/extension.js and dist/webview.js');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
