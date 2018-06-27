const debug = require('debug')('test-helper');
const assert = require('assert');
const Promise = require('promise');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const _ = require('lodash');
const data = require('../src/data');
const builder = require('../src/v1');
const taskcluster = require('taskcluster-client');
const mocha = require('mocha');
const load = require('../src/main');
const exchanges = require('../src/exchanges');
const slugid = require('slugid');
const Config = require('typed-env-config');
const azure = require('fast-azure-storage');
const containers = require('../src/containers');
const uuid = require('uuid');
const Builder = require('taskcluster-lib-api');
const SchemaSet = require('taskcluster-lib-validate');
const App = require('taskcluster-lib-app');
const Exchanges = require('pulse-publisher');
const libUrls = require('taskcluster-lib-urls');
const {fakeauth, stickyLoader, Secrets} = require('taskcluster-lib-testing');

exports.suiteName = path.basename;

exports.load = stickyLoader(load);

suiteSetup(async function() {
  exports.load.inject('profile', 'test');
  exports.load.inject('process', 'test');
});

const PROXY_PORT = 60551;
exports.rootUrl = `http://localhost:${PROXY_PORT}`;

// set up the testing secrets
exports.secrets = new Secrets({
  secretName: 'project/taskcluster/testing/taskcluster-auth',
  secrets: {
    azure: [
      {env: 'AZURE_ACCOUNT_ID', cfg: 'azure.accountId', name: 'accountId'},
      {env: 'AZURE_ACCOUNT_KEY', cfg: 'azure.accountKey', name: 'accountKey'},
    ],
    taskcluster: [
      {env: 'TASKCLUSTER_ROOT_URL', cfg: 'taskcluster.rootUrl', name: 'rootUrl', mock: exports.rootUrl},
    ],
  },
  load: exports.load,
});

exports.withCfg = (mock, skipping) => {
  if (skipping()) {
    return;
  }
  suiteSetup(async function() {
    exports.cfg = await exports.load('cfg');
  });
};

/**
 * Set helper.<Class> for each of the Azure entities used in the service
 */
exports.withEntities = (mock, skipping) => {
  const tables = [
    {name: 'Client'},
  ];

  suiteSetup(async function() {
    if (skipping()) {
      return;
    }

    if (mock) {
      const cfg = await exports.load('cfg');
      exports.testaccount = _.keys(cfg.app.azureAccounts)[0];
      await Promise.all(tables.map(async tbl => {
        exports.load.inject(tbl.name, data[tbl.className || tbl.name].setup({
          tableName: tbl.name,
          credentials: 'inMemory',
          context: tbl.context ? await tbl.context() : undefined,
          cryptoKey: cfg.azure.cryptoKey,
          signingKey: cfg.azure.signingKey,
        }));
      }));
    }

    await Promise.all(tables.map(async tbl => {
      exports[tbl.name] = await exports.load(tbl.name);
      await exports[tbl.name].ensureTable();
    }));
  });

  const cleanup = async () => {
    if (skipping()) {
      return;
    }

    await Promise.all(tables.map(async tbl => {
      await exports[tbl.name].scan({}, {handler: e => {
        // This is assumed to exist accross tests in many places
        if (tbl.name === 'Client' && e.clientId === 'static/taskcluster/root') {
          return;
        }
        e.remove();
      }});
    }));
  };
  setup(cleanup);
  suiteTeardown(cleanup);
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

/**
 * Setup the Roles blob
 */
exports.withRoles = (mock, skipping) => {
  suiteSetup(async function() {
    if (skipping()) {
      return;
    }

    if (mock) {
      const cfg = await exports.load('cfg');
      exports.Roles = new FakeRoles();
      exports.load.inject('Roles', exports.Roles);
    }
  });

  const cleanup = async () => {
    if (skipping()) {
      return;
    }
    if (mock) {
      exports.Roles.roles = [];
    } else {
      // TODO: Figure out what to do with this old bit! Is it still necessary?
      //const blobService = new azure.Blob({
      //  accountId: cfg.azure.accountName,
      //  accountKey: cfg.azure.accountKey,
      //});
      //try {
      //  await blobService.deleteContainer(helper.containerName);
      //} catch (e) {
      //  if (e.code !== 'ResourceNotFound') {
      //    throw e;
      //  }
      //  // already deleted, so nothing to do
      //  // NOTE: really, this doesn't work -- the container doesn't register as existing
      //  // before the tests are complete, so we "leak" containers despite this effort to
      //  // clean them up.
      //}
    }
  };
  setup(cleanup);
  suiteTeardown(cleanup);
};

/**
 * Set up PulsePublisher in fake mode, at helper.publisher. Messages are stored
 * in helper.messages.  The `helper.checkNextMessage` function allows asserting the
 * content of the next message, and `helper.checkNoNextMessage` is an assertion that
 * no such message is in the queue.
 */
exports.withPulse = (mock, skipping) => {
  suiteSetup(async function() {
    if (skipping()) {
      return;
    }

    await exports.load('cfg');
    exports.load.cfg('taskcluster.rootUrl', exports.rootUrl);
    exports.load.cfg('pulse', {fake: true});
    exports.publisher = await exports.load('publisher');

    exports.checkNextMessage = (exchange, check) => {
      for (let i = 0; i < exports.messages.length; i++) {
        const message = exports.messages[i];
        // skip messages for other exchanges; this allows us to ignore
        // ordering of messages that occur in indeterminate order
        if (!message.exchange.endsWith(exchange)) {
          continue;
        }
        check && check(message);
        exports.messages.splice(i, 1); // delete message from queue
        return;
      }
      throw new Error(`No messages found on exchange ${exchange}; ` +
        `message exchanges: ${JSON.stringify(exports.messages.map(m => m.exchange))}`);
    };

    exports.checkNoNextMessage = exchange => {
      assert(!exports.messages.some(m => m.exchange.endsWith(exchange)));
    };
  });

  const fakePublish = msg => { exports.messages.push(msg); };
  setup(function() {
    exports.messages = [];
    exports.publisher.on('fakePublish', fakePublish);
  });

  teardown(function() {
    exports.publisher.removeListener('fakePublish', fakePublish);
  });
};

let testServiceBuilder = new Builder({
  title: 'Test API Server',
  description: 'API server for testing',
  serviceName: 'authtest',
  version: 'v1',
});

testServiceBuilder.declare({
  method:       'get',
  route:        '/resource',
  name:         'resource',
  scopes:       {AllOf: ['myapi:resource']},
  title:        'Get Resource',
  description:  '...',
}, function(req, res) {
  res.status(200).json({
    message: 'Hello World',
  });
});

/**
 * Set up API servers.  Call this after withEntities, so the server
 * uses the same entities classes.
 *
 * This is both the auth service and a testing service running behind
 * a reverse proxy.
 *
 * This also sets up helper.apiClient as a client of the service API.
 */
exports.withServers = (mock, skipping) => {

  let webServer;
  let testServer;

  suiteSetup(async function() {
    if (skipping()) {
      return;
    }
    debug('starting servers');
    const cfg = await exports.load('cfg');

    exports.load.cfg('taskcluster.rootUrl', exports.rootUrl);
    exports.rootAccessToken = '-test-access-token-';

    // First set up the auth service
    exports.AuthClient = taskcluster.createClient(builder.reference());

    exports.setupScopes = (...scopes) => {
      exports.apiClient = new exports.AuthClient({
        credentials: {
          clientId:       'static/taskcluster/root',
          accessToken:    exports.rootAccessToken,
        },
        rootUrl: exports.rootUrl,
        authorizedScopes: scopes.length > 0 ? scopes : undefined,
      });
    };
    exports.setupScopes();

    webServer = await exports.load('server');

    // Now set up the test service
    exports.TestClient = taskcluster.createClient(testServiceBuilder.reference());
    exports.testClient = new exports.TestClient({
      credentials: {
        clientId:       'static/taskcluster/root',
        accessToken:    exports.rootAccessToken,
      },
      rootUrl: exports.rootUrl,
    });

    const testServiceName = 'authtest';
    const testServiceApi = await testServiceBuilder.build({
      rootUrl: exports.rootUrl,
      schemaset: new SchemaSet({
        serviceName: testServiceName,
      }),
    });

    testServer = await App({
      port:           60553,
      env:            'development',
      forceSSL:       false,
      trustProxy:     false,
      rootDocsLink:   false,
      apis:           [testServiceApi],
    });

    // Finally, we set up a proxy that runs on rootUrl
    // and sends requests to either of the services based on path.

    const proxy = httpProxy.createProxyServer({});
    const proxier = http.createServer(function(req, res) {
      if (req.url.startsWith('/api/auth/')) {
        proxy.web(req, res, {target: 'http://localhost:60552'});
      } else if (req.url.startsWith(`/api/${testServiceName}/`)) {
        proxy.web(req, res, {target: 'http://localhost:60553'});
      } else {
        throw new Error(`Unknown service request: ${req.url}`);
      }
    });
    proxier.listen(PROXY_PORT);

  });

  beforeEach(() => {
    exports.setupScopes();
  });

  suiteTeardown(async function() {
    if (skipping()) {
      return;
    }
    debug('shutting down servers');
    if (webServer) {
      await webServer.terminate();
      webServer = null;
    }
    if (testServer) {
      await testServer.terminate();
      testServer = null;
    }
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
