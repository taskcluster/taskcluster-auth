let api = require('./v1');
let Statsum = require('statsum');

api.declare({
  method:     'get',
  route:      '/statsum/:project/token',
  name:       'statsumToken',
  input:      undefined,
  output:     'statsum-token-response.json#',
  deferAuth:  true,
  stability:  'stable',
  scopes:     [['auth:statsum-token:<project>']],
  title:      "Get Token for Statsum Project",
  description: [
    "Get temporary `token` and `baseUrl` for sending metrics to statsum.",
    "",
    "The token is valid for 25 hours, clients should refresh it within",
    "24 hours.",
  ].join('\n')
}, async function(req, res) {
  let project = req.params.project;

  // Check scopes
  if (!req.satisfies({project})) {
    return;
  }

  return res.reply({
    project,
    token:    Statsum.createToken(project, this.statsum.secret, '25h'),
    baseUrl:  this.statsum.baseUrl,
  });
});
