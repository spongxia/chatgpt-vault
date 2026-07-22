import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('sync index reports remote timestamps without returning message bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-vault-server-'));
  process.env.CHATGPT_VAULT_DATA_DIR = directory;
  const { healthPayload, importConversations, syncIndex, updateConversationMessage } = await import(`../server.mjs?test=${Date.now()}`);

  try {
    const imported = await importConversations({
      conversations: [{
          id: 'remote-1',
          title: '远端同步测试',
          update_time: 1710000100,
          is_archived: true,
          current_node: 'assistant-node',
          mapping: {
            'user-node': {
              id: 'user-node',
              parent: null,
              message: {
                id: 'user-message',
                author: { role: 'user' },
                content: { parts: ['问题'] },
                create_time: 1710000001
              }
            },
            'assistant-node': {
              id: 'assistant-node',
              parent: 'user-node',
              message: {
                id: 'assistant-message',
                author: { role: 'assistant' },
                content: { parts: ['回答'] },
                create_time: 1710000002
              }
            }
          }
        }]
    });
    assert.equal(imported.imported, 1);

    const index = await syncIndex();
    assert.equal(index.length, 1);
    assert.equal(index[0].id, 'remote-1');
    assert.equal(index[0].remoteArchived, true);
    assert.equal(index[0].messageCount, 2);
    assert.equal('messages' in index[0], false);

    const edited = await updateConversationMessage('remote-1', 'assistant-message', { content: '本地编辑后的回答' });
    assert.equal(edited.messages[1].content, '本地编辑后的回答');
    assert.ok(edited.messages[1].metadata.vaultEditedAt);

    const health = healthPayload();
    const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(health.version, packageMetadata.version);
    assert.equal(health.apiVersion, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
