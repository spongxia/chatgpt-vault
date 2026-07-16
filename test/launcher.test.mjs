import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const launcherPath = new URL('../launcher/ChatGPT Vault Launcher.app/Contents/MacOS/launcher', import.meta.url);

test('ships a zero-dependency macOS launcher', async () => {
  const source = await readFile(launcherPath, 'utf8');
  const metadata = await stat(launcherPath);

  assert.match(source, /^#!\/bin\/zsh/);
  assert.match(source, /process\.versions\.node/);
  assert.match(source, /Node\.js 18/);
  assert.match(source, /npm install/);
  assert.match(source, /127\.0\.0\.1:4318/);
  assert.match(source, /open "\$URL"/);
  assert.match(source, /nodejs\.org/);
  assert.doesNotMatch(source, /electron|tauri/i);
  assert.ok((metadata.mode & 0o111) !== 0, 'launcher must be executable');
});
