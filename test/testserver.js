let Builder     = require('taskcluster-lib-api');
let SchemaSet   = require('taskcluster-lib-validate');
let App         = require('taskcluster-lib-app');
let taskcluster = require('taskcluster-client');

// Create a simple test server that we can send test requests to, useful for
// testing that validation works as expected.

const PORT = 60321;
const rootUrl = `http://localhost:${PORT}`;

let builder = new Builder({
  title: 'Test API Server',
  description: 'API server for testing',
  serviceName: 'authtest',
  version: 'v1',
});

builder.declare({
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

module.exports = async ({rootAccessToken}) => {
  let api = builder.build({
    schemaset: new SchemaSet({
      serviceName: 'authtest',
    }),
  });

  let serverApp = App({
    port:           PORT,
    env:            'development',
    forceSSL:       false,
    trustProxy:     false,
    rootDocsLink:   false,
    apis:           [api],
  });

  let reference = builder.reference({rootUrl});
  let MyClient = taskcluster.createClient(reference);
  let myClient = new MyClient({
    baseUrl,
    credentials: {
      clientId: 'static/taskcluster/root',
      accessToken: rootAccessToken,
    },
  });

  return {
    server,
    reference,
    baseUrl,
    Client: MyClient,
    client: myClient,
  };
};
