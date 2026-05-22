import { writeFile } from 'node:fs/promises';
import { progressMarkdownPath } from './config.mjs';
import { renderProgressMarkdown } from './render-progress.mjs';

export async function writeRenderedProgress(progress, path = progressMarkdownPath) {
  await writeFile(path, renderProgressMarkdown(progress), 'utf8');
}
