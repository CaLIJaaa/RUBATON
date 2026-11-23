import { pathToFileURL } from 'node:url';
import { createTenderlySetupServer } from '../server/tenderly-setup.ts';

export async function runTenderlyUi(): Promise<void> {
  const value = process.env.PORT ?? '3001';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error('PORT должен быть целым числом от 1 до 65535.');
  }
  const port = Number(value);
  const app = createTenderlySetupServer({ port });
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
    });
    console.log(`Настройка Tenderly: http://127.0.0.1:${port}/setup`);
    console.log('Вставьте RPC нового форка и адрес кошелька на странице. Ctrl+C остановит UI, сохранив рынок.');
    await new Promise<void>((resolve) => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally { await app.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTenderlyUi().catch((error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE'
      ? 'Порт UI занят. Остановите npm run dev или задайте PORT=3002 npm run tenderly.'
      : error.code === 'EPERM'
        ? 'Окружение запрещает локальные порты. Запустите npm run tenderly в обычном терминале.'
        : 'Не удалось запустить страницу настройки Tenderly. Проверьте PORT и доступность файлов проекта.');
    process.exitCode = 1;
  });
}
