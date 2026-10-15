import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevelopmentServer } from '../server/dev.mjs';

test('development server resolves exported browser dependencies and example assets', async () => {
  const server = createDevelopmentServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const resource of ['/node_modules/jspsych/dist/index.browser.js', '/node_modules/@jspsych/plugin-survey-text/dist/index.browser.js', '/examples/builder.css']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${resource}`);
      assert.equal(response.status, 200, resource);
      assert.ok((await response.text()).length > 0);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
