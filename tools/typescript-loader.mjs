import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Retain the original file URLs: the application resolves its UI and contract
// artifacts relative to import.meta.url. No generated copies or new dependency.
export async function load(url, context, nextLoad) {
  const sourceUrl = new URL(url);
  if (sourceUrl.protocol !== 'file:' || !sourceUrl.pathname.endsWith('.ts')) {
    return nextLoad(url, context);
  }
  const source = await readFile(sourceUrl, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: sourceUrl.pathname,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      inlineSourceMap: true,
      inlineSources: true,
    },
  });
  return { format: 'module', source: result.outputText, shortCircuit: true };
}
