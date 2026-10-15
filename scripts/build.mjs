import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
await mkdir('dist', { recursive: true });
await build({
  entryPoints: { index: 'src/index.ts', core: 'src/core/index.ts', cloudpsych: 'src/cloudpsych.ts', research: 'src/research/public.ts', speech: 'src/speech/index.ts' },
  outdir: 'dist', bundle: true, format: 'esm', target: 'es2022', external: ['jspsych'], sourcemap: true
});
const browserOptions = {
  entryPoints: ['src/index.ts'], outfile: 'dist/jspsych-ai.browser.js', bundle: true,
  format: 'iife', globalName: 'JsPsychAI', target: 'es2022', sourcemap: true, charset: 'utf8',
  plugins: [{ name: 'jspsych-runtime', setup(builder) {
    builder.onResolve({ filter: /^jspsych$/ }, () => ({ path: 'jspsych', namespace: 'runtime' }));
    builder.onLoad({ filter: /.*/, namespace: 'runtime' }, () => ({
      contents: 'export const ParameterType = window.jsPsychModule.ParameterType;', loader: 'js'
    }));
  } }]
};
await build(browserOptions);
await build({ ...browserOptions, outfile: 'dist/jspsych-ai.browser.min.js', minify: true, sourcemap: false, legalComments: 'none' });
await build({ ...browserOptions, entryPoints: ['src/cloudpsych-runtime.ts'], outfile: 'dist/jspsych-ai.cloudpsych.min.js', minify: true, sourcemap: false, legalComments: 'none' });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
await copyFile('src/style.css', 'dist/style.css');
await mkdir('dist/licenses', { recursive: true });
for (const [dependency, license] of [['ajv', 'LICENSE'], ['fast-deep-equal', 'LICENSE'], ['fast-uri', 'LICENSE'], ['json-schema-traverse', 'LICENSE'], ['require-from-string', 'license'], ['ws', 'LICENSE']]) {
  await copyFile(`node_modules/${dependency}/${license}`, `dist/licenses/${dependency}.txt`);
}
console.log('Built ESM, browser bundle, declarations and styles (jsPsych 7.3.4).');
