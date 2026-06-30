import assert from 'node:assert';
import { getOrCreateProfileId } from '../../webmcp-extension/dist/bg/profile-id.js';

function makeFakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, obj);
    },
  };
}

async function run() {
  // 1. Generates and persists a new id on first call.
  const storage = makeFakeStorage();
  let generated = 0;
  const id = await getOrCreateProfileId(storage, () => {
    generated += 1;
    return 'fixed-uuid';
  });
  assert.strictEqual(id, 'fixed-uuid', 'returns the generated id');
  assert.strictEqual(generated, 1, 'generator called exactly once');
  assert.strictEqual(storage.data['webmcp_profile_id'], 'fixed-uuid', 'persists under webmcp_profile_id');

  // 2. Returns the persisted id on subsequent calls without regenerating.
  const id2 = await getOrCreateProfileId(storage, () => {
    generated += 1;
    return 'should-not-be-used';
  });
  assert.strictEqual(id2, 'fixed-uuid', 'returns persisted id');
  assert.strictEqual(generated, 1, 'generator not called again');

  console.log('profile-id.test.mjs OK');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
