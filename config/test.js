module.exports = {
  // Component specific configuration
  auth: {
    clientTableName:      'TestClients',
    rolesTableName:       'TestRoles',
    tableSigningKey:      'not-a-secret-so-you-cant-guess-it',
    tableCryptoKey:       'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',

    // Publish references and schemas
    publishMetaData:                'false',

    // Name of component in statistics
    statsComponent:                 'auth-tests',

    // root accessToken used for testing
    rootAccessToken:   'EO-5D7oBTYWMTJ79HYGf-guFVXRtIbRKWoXOyb9EpkIQ',

    // Must be configured locally
    azureAccounts:    "{}",

    clientIdForTempCreds: 'ctVNevJPRbe6ICL5-nhZkw'
  },

  test: {
    // Bucket that we can use for testing issued STS credentials
    testBucket:                     undefined
  },

  // Server configuration
  server: {
    // Public URL from which the server can be accessed (used for persona)
    publicUrl:                      'http://localhost:60551',

    // Port to listen for requests on
    port:                           60551,

    // Run in development mode (logging and error handling)
    development:                    true
  }
};