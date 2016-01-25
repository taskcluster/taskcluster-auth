suite('user stories', function() {
  var Promise     = require('promise');
  var assert      = require('assert');
  var debug       = require('debug')('test:client');
  var helper      = require('./helper');
  var slugid      = require('slugid');
  var _           = require('lodash');
  var assume      = require('assume');
  var base        = require('taskcluster-base');
  var taskcluster = require('taskcluster-client');

  suite("charlene creates permanent credentials for a test runner", function() {
    let cleanup = async () => {
      await helper.auth.deleteRole('client-id:test-users/test');
      await helper.auth.deleteClient('test-users');
      await helper.auth.deleteClient('test-users/charlene/travis-tests');
    };
    before(cleanup);

    // NOTE: these tests run in order
    var identityProvider,
        identityProviderToken,
        charlene,
        travis_tests;

    test("add a client for the identity provider", async () => {
      let idp = await helper.auth.createClient('test-users', {
        description: "Test users identity provider",
        expires: taskcluster.fromNow("2 hours"),
        scopes: [
          'auth:create-client:test-users/*',
          'auth:update-client:test-users/*',
          'auth:enable-client:test-users/*',
          'auth:delete-client:test-users/*',
          'auth:reset-access-token:test-users/*',
          'assume:test-role:*',
        ],
      });

      identityProviderToken = idp.accessToken;
      identityProvider = new helper.Auth({
        credentials: {
          clientId: 'test-users',
          accessToken: identityProviderToken
        }
      });
    });

    test("add role3", async () => {
      await helper.auth.createRole('test-role:role3', {
        description: "role 3",
        scopes: ['scope3a', 'scope3b'],
      });
    });

    test("create temporary credentials for charlene's browser login", async () => {
      charlene = new helper.Auth({
        credentials: taskcluster.createTemporaryCredentials({
          start: new Date(),
          expiry: taskcluster.fromNow("1 hour"),
          credentials: {
            clientId: 'test-users',
            accessToken: identityProviderToken
          },
          scopes: [
            'auth:create-client:test-users/charlene/*',
            'auth:update-client:test-users/charlene/*',
            'auth:delete-client:test-users/charlene/*',
            'auth:reset-access-token:test-users/charlene/*',
            'assume:test-role:role1',
            'assume:test-role:role2',
          ],
        }),
      });
    });

    test("charlene creates permanent credentials for her tests", async () => {
      travis_tests = await charlene.createClient('test-users/charlene/travis-tests', {
        description: "Permacred created by test",
        expires: taskcluster.fromNow("3 hours"), // N.B. longer than temp creds
        scopes: [
          'assume:test-role:role1',
        ],
      });
    });

    // test some access-control

    test("charlene tries to grant role3 (which she does not have) to her client", async () => {
      try {
        travis_tests = await charlene.updateClient('test-users/charlene/travis-tests', {
          description: "Permacred created by test",
          expires: taskcluster.fromNow("3 hours"),
          scopes: [
            'assume:test-role:role1',
            'assume:test-role:role3',
          ],
        });
        throw new Error("did not get expected error");
      } catch (err) {
        assume(err.statusCode).to.equal(401);
      }
    });

    test("charlene grants role2 and removes role1", async () => {
      travis_tests = await charlene.updateClient('test-users/charlene/travis-tests', {
        description: "Permacred created by test",
        expires: taskcluster.fromNow("3 hours"),
        scopes: [
          'assume:test-role:role2',
        ],
      });
    });

    test("root grants role3", async () => {
      travis_tests = await helper.auth.updateClient('test-users/charlene/travis-tests', {
        description: "Permacred created by test",
        expires: taskcluster.fromNow("3 hours"),
        scopes: [
          'assume:test-role:role2',
          'assume:test-role:role3',
        ],
      });
    });

    test("charlene revokes role3", async () => {
      travis_tests = await charlene.updateClient('test-users/charlene/travis-tests', {
        description: "Permacred created by test",
        expires: taskcluster.fromNow("3 hours"),
        scopes: [
          'assume:test-role:role2',
        ],
      });
    });

    test("root grants role3 again", async () => {
      travis_tests = await helper.auth.updateClient('test-users/charlene/travis-tests', {
        description: "Permacred created by test",
        expires: taskcluster.fromNow("3 hours"),
        scopes: [
          'assume:test-role:role3',
        ],
      });
    });

    // TODO: bug 1242473
    test.skip("charlene replaces role3 with one of its constituent scopes", async () => {
      travis_tests = await charlene.updateClient('test-users/charlene/travis-tests', {
        description: "Permacred created by test",
        expires: taskcluster.fromNow("3 hours"),
        scopes: [
          'scope3a',
        ],
      });
    });
  });
});
