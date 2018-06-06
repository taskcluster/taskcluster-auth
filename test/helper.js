var assert      = require('assert');
var Promise     = require('promise');
var path        = require('path');
var _           = require('lodash');
var testing     = require('taskcluster-lib-testing');
var data        = require('../src/data');
var v1          = require('../src/v1');
var taskcluster = require('taskcluster-client');
var mocha       = require('mocha');
var serverLoad  = require('../src/main');
var exchanges   = require('../src/exchanges');
var testserver  = require('./testserver');
var slugid      = require('slugid');
var Config      = require('typed-env-config');
var azure       = require('fast-azure-storage');
var containers  = require('../src/containers');
var uuid        = require('uuid');
var Exchanges = require('pulse-publisher');

// Load configuration
var cfg = Config({profile: 'test'});

// Create subject to be tested by test
var helper = module.exports = {};

// Use a unique container name per run, so that parallel test runs
// do not interfere with each other.
helper.containerName = `auth-test-${uuid.v4()}`;

helper.cfg = cfg;
helper.testaccount = _.keys(cfg.app.azureAccounts)[0];
helper.rootAccessToken = '-test-access-token-';

helper.hasPulseCredentials = function() {
  return cfg.pulse.hasOwnProperty('password') && cfg.pulse.password;
};

helper.hasAzureCredentials = function() {
  return cfg.app.hasOwnProperty('azureAccounts') && cfg.app.azureAccounts;
};

// fake "Roles" container
class FakeRoles {
  constructor() {
    this.roles = [];
  }

  async get() {
    return this.roles;
  }

  async modify(modifier) {
    await modifier(this.roles);
  }
}

class FakePublisher {
  constructor() {
    this.calls= [];
  }

  async clientCreated({clientId}) {
    if (this.calls.filter(call => call.method == 'clientCreated' && call.clientId == clientId).length  == 0) {
      this.calls.push({method: 'clientCreated', clientId});
    }
    return Promise.resolve();
  }

  async clientUpdated({clientId}) {
    this.calls.push({method:'clientUpdated', clientId});
    return Promise.resolve();
  }

  async clientDeleted({clientId}) {
    if (this.calls.filter(call => call.method == 'clientDeleted' && call.clientId == clientId).length  == 0) {
      this.calls.push({method:'clientDeleted', clientId});
    }
    return Promise.resolve();
  }

  async roleUpdated({roleId}) {
    this.calls.push({method:'roleUpdated', roleId});
    return Promise.resolve();
  }

  async roleCreated({roleId}) {
    if (this.calls.filter(call => call.method == 'roleCreated' && call.roleId == roleId).length  == 0) {
      this.calls.push({method:'roleCreated', roleId});
    }

    return Promise.resolve();
  }

  async roleDeleted({roleId}) {
    if (this.calls.filter(call => call.method == 'roleDeleted' && call.roleId == roleId).length  == 0) {
      this.calls.push({method:'roleDeleted', roleId});
    }
    return Promise.resolve();
  }
}

var webServer = null, testServer;
mocha.before(async () => {
  let overwrites = {};
  overwrites['profile'] = 'test';
  overwrites['process'] = 'test';
  helper.overwrites = overwrites;
  helper.load = serverLoad;

  // if we don't have an azure account/key, use the inmemory version
  if (!cfg.azure || !cfg.azure.accountName) {
    let signingKey = cfg.app.tableSigningKey;
    let cryptoKey = cfg.app.tableCryptoKey;
    helper.Client = overwrites['Client'] = data.Client.setup({
      table: 'Client',
      account: 'inMemory',
      credentials: null,
      cryptoKey,
      signingKey,
    });
    helper.Roles = overwrites['Roles'] = new FakeRoles();
  } else {
    helper.Client = overwrites['Client'] = await serverLoad('Client', overwrites);
    helper.Roles = overwrites['Roles'] = new containers.Roles({
      containerName: helper.containerName,
      credentials: cfg.azure,
    });
    await helper.Roles.setup();
  }

  overwrites.publisher = helper.publisher = new FakePublisher();

  overwrites.resolver = helper.resolver =
    await serverLoad('resolver', overwrites);

  overwrites.connection = new taskcluster.PulseConnection({fake: true});

  webServer = await serverLoad('server', overwrites);
  webServer.setTimeout(3500); // >3s because Azure can be sloooow
  helper.baseUrl = 'http://localhost:' + webServer.address().port + '/v1';

  var reference = v1.reference({baseUrl: helper.baseUrl});
  helper.Auth = taskcluster.createClient(reference);
  helper.scopes = (...scopes) => {
    helper.auth = new helper.Auth({
      baseUrl:          helper.baseUrl,
      credentials: {
        clientId:       'static/taskcluster/root',
        accessToken:    helper.rootAccessToken,
      },
      authorizedScopes: scopes.length > 0 ? scopes : undefined,
    });
  };
  helper.scopes();

  // Create test server
  let {
    server:     testServer_,
    reference:  testReference,
    baseUrl:    testBaseUrl,
    Client:     TestClient,
    client:     testClient,
  } = await testserver({
    rootAccessToken: helper.rootAccessToken,
  });

  testServer = testServer_;
  helper.testReference  = testReference;
  helper.testBaseUrl    = testBaseUrl;
  helper.TestClient     = TestClient;
  helper.testClient     = testClient;

  var exchangeReference = exchanges.reference({
    exchangePrefix:   cfg.app.exchangePrefix,
    credentials:      {fake: true},
  });
  helper.AuthEvents = taskcluster.createClient(exchangeReference);
  helper.authEvents = new helper.AuthEvents();
});

mocha.beforeEach(() => {
  // Setup client with all scopes
  helper.scopes();
  helper.publisher.calls = [];
});

// Cleanup after tests
mocha.after(async () => {
  if (cfg.azure && cfg.azure.accountName && cfg.azure.accountKey) {
    const blobService = new azure.Blob({
      accountId: cfg.azure.accountName,
      accountKey: cfg.azure.accountKey,
    });
    try {
      await blobService.deleteContainer(helper.containerName);
    } catch (e) {
      if (e.code !== 'ResourceNotFound') {
        throw e;
      }
      // already deleted, so nothing to do
      // NOTE: really, this doesn't work -- the container doesn't register as existing
      // before the tests are complete, so we "leak" containers despite this effort to
      // clean them up.
    }
  }
  // Kill servers
  if (testServer) {
    await testServer.terminate();
  }
  if (webServer) {
    await webServer.terminate();
  }

});
