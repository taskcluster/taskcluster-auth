const assert = require('assert');
const Promise = require('promise');
const path = require('path');
const _ = require('lodash');
const data = require('../src/data');
const v1 = require('../src/v1');
const taskcluster = require('taskcluster-client');
const mocha = require('mocha');
const load = require('../src/main');
const exchanges = require('../src/exchanges');
const testserver = require('./testserver');
const slugid = require('slugid');
const Config = require('typed-env-config');
const azure = require('fast-azure-storage');
const containers = require('../src/containers');
const uuid = require('uuid');
const Exchanges = require('pulse-publisher');
const {fakeauth, stickyLoader, Secrets} = require('taskcluster-lib-testing');


exports.load = stickyLoader(load);

suiteSetup(async function() {
  exports.load.inject('profile', 'test');
  exports.load.inject('process', 'test');
});

/**
 * Set up an API server.  Call this after withEntities, so the server
 * uses the same entities classes.
 *
 * This also sets up helper.apiClient as a client of the service API.
 */
exports.withServers = (mock, skipping) => {
  let webServer; // This is the auth service running under test
  let testServer; // This is a demo service that is used to test things


  // AUAHUTILUSEHGLUSHEG! We run two services in these tests. How can we do
  // this with a single rootUrl? We'll need to make a weird load balancer thing
  // for testing maybe???

  suiteSetup(async function() {
    if (skipping()) {
      return;
    }
    const cfg = await exports.load('cfg');

    // even if we are using a "real" rootUrl for access to Azure, we use
    // a local rootUrl to test the API, including mocking auth on that
    // rootUrl.
    const rootUrl = 'http://localhost:60551';
    exports.load.cfg('taskcluster.rootUrl', rootUrl);

    fakeauth.start({'test-client': ['*']}, {rootUrl});

    const GithubClient = taskcluster.createClient(builder.reference());

    exports.apiClient = new GithubClient({
      credentials: {clientId: 'test-client', accessToken: 'unused'},
      rootUrl,
    });

    webServer = await exports.load('server');
  });

  suiteTeardown(async function() {
    if (skipping()) {
      return;
    }
    if (webServer) {
      await webServer.terminate();
      webServer = null;
    }
    fakeauth.stop();
  });
};











/**
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
  if (!cfg.azure || !cfg.azure.accountId) {
    let signingKey = cfg.app.tableSigningKey;
    let cryptoKey = cfg.app.tableCryptoKey;
    helper.Client = overwrites['Client'] = data.Client.setup({
      tableName: 'Client',
      credentials: 'inMemory',
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
**/
