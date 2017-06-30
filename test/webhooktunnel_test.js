suite('webhooktunnel', () => {
  let helper = require('./helper');
  let assert = require('assert');
  let jwt = require('jsonwebtoken');

  test('webhooktunnelToken', async () => {
    let {token, id} = await helper.auth.webhooktunnelToken();
    let decoded = jwt.decode(token);
    assert(decoded !== null);
    assert(decoded.tid === id);
  });
});
