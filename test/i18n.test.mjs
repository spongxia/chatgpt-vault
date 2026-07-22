import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getLanguage,
  LANGUAGE_OPTIONS,
  setLanguage,
  t
} from '../public/i18n.js';

test('ships all requested interface languages', () => {
  assert.deepEqual(
    LANGUAGE_OPTIONS.map(([code]) => code),
    ['en', 'zh-CN', 'fr', 'es', 'ja', 'ar', 'de', 'it', 'pt']
  );
});

test('each language provides translated core and renderer labels', () => {
  for (const [code] of LANGUAGE_OPTIONS) {
    setLanguage(code, { persist: false, notify: false });
    assert.equal(getLanguage(), code);
    assert.notEqual(t('welcomeTitle'), 'welcomeTitle');
    assert.notEqual(t('importChats'), 'importChats');
    assert.notEqual(t('toolWeb'), 'toolWeb');
    assert.notEqual(t('sources', { count: 3 }), 'sources');
    assert.notEqual(t('editMessage'), 'editMessage');
    assert.notEqual(t('messageUpdated'), 'messageUpdated');
    assert.notEqual(t('batchMarkdownZip'), 'batchMarkdownZip');
    assert.notEqual(t('jpgDesc'), 'jpgDesc');
    assert.notEqual(t('pdfDesc'), 'pdfDesc');
    assert.notEqual(t('serverRestartRequired'), 'serverRestartRequired');
  }
});
