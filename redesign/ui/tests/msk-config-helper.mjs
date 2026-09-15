import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

export function loadMskConfig(origin) {
  const source = readFileSync(new URL('../src/chat/msk/config.ts', import.meta.url), 'utf8')
    .replace('import.meta.env.VITE_MSK_ORIGIN', 'configuredOrigin');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, URL, configuredOrigin: origin });
  return exports;
}
