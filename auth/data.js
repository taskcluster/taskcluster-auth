var debug   = require('debug')('auth:data');
var base    = require('taskcluster-base');
var assert  = require('assert');
var _       = require('lodash');

var Client = base.Entity.configure({
  version:          1,
  partitionKey:     base.Entity.keys.StringKey('clientId'),
  rowKey:           base.Entity.keys.ConstantKey('client'),
  signEntities:     true,
  properties: {
    clientId:       base.Entity.types.String,
    description:    base.Entity.types.Text,
    accessToken:    base.Entity.types.EncryptedText,
    expires:        base.Entuty.types.Date,
    /**
     * Details object with properties:
     * - created          // Time when client was created
     * - lastModified     // Last time client was modified
     * - lastDateUsed     // Only updated if more than 6 hours out of date
     * - lastRotated      // Last time accessToken was reset
     * (more properties may be added in the future)
     */
    details:        base.Entity.types.JSON
  }
});

/** Get JSON representation of client */
Client.prototype.json = function() {
  return {
    clientId:       this.clientId,
    description:    this.description,
    expires:        this.expires.toJSON(),
    created:        this.details.created,
    lastModified:   this.details.lastModified,
    lastDateUsed:   this.details.lastDateUsed,
    lastRotated:    this.details.lastRotated
  };
};

/**
 * Ensure root client exists and has the given accessToken.
 * If accessToken has changed (or isn't set) root client will be overwritten,
 * and expires set 30 min into the future.
 *
 * Should only be called if the app is configured with a rootAccessToken.
 * Otherwise, app should assume whatever is in the table storage is the
 * root access token, and that appropriate role is attached.
 *
 * Basically, this is for bootstrapping only.
 */
Client.ensureRootClient = async function(accessToken) {
  assert(typeof(accessToken) === 'string',
         "Expected accessToken to be a string");
  let Client = this;

  let client = await Client.load({clientId: 'root'}, true);
  if (client) {
    return client.modify(client => {
      if (client.accessToken !== accessToken) {
        client.accessToken            = accessToken;
        client.description            = "Automatically created `root` client " +
                                        "for bootstrapping API access.";
        client.expires                = taskcluster.fromNow('30 min'),
        client.details.created        = new Date().toJSON();
        client.details.lastModified   = new Date().toJSON();
        client.details.lastDateUsed   = new Date().toJSON();
        client.details.lastRotated    = new Date().toJSON();
      }
    });
  }

  // Create client resolving conflicts by overwriting
  await Client.create({
    clientId:         'root',
    description:      "Automatically created `root` client " +
                      "for bootstrapping API access";
    accessToken:      accessToken,
    expires:          taskcluster.fromNow('30 min'),
    details: {
      created:        new Date().toJSON(),
      lastModified:   new Date().toJSON(),
      lastDateUsed:   new Date().toJSON(),
      lastRotated:    new Date().toJSON()
    }
  }, true);
};

// Export Client
exports.Client = Client;

var Role = base.Entity.configure({
  version:          1,
  partitionKey:     base.Entity.keys.StringKey('roleId'),
  rowKey:           base.Entity.keys.ConstantKey('role'),
  signEntities:     true,
  properties: {
    roleId:         base.Entity.types.String,
    description:    base.Entity.types.Text,
    scopes:         base.Entity.types.JSON,
    /**
     * Details object with properties:
     * - created
     * - lastModified
     * (more properties may be added in the future)
     */
    details:        base.Entity.types.JSON,
  }
});

/** Get JSON representation of client */
Role.prototype.json = function(resolver) {
  return {
    roleId:         this.roleId,
    description:    this.description,
    created:        this.details.created,
    lastModified:   this.details.lastModified,
    scopes:         this.scopes,
    expandedScopes: resolver.resolve(this.scopes)
  };
};

/**
 * Ensure the role: client-id:root -> ['*'] exists
 *
 * Should only be called if the app is configured with a rootAccessToken.
 * Otherwise, app should assume whatever is in the table storage is the
 * root access token, and that appropriate role is attached.
 *
 * Basically, this is for bootstrapping only.
 */
Role.ensureRootRole = function() {
  let Role = this;
  return Role.create({
    roleId:       'client-id:root',
    description:  "Automatically created role for bootstrapping the `root` "+
                  "client.",
    scopes:       ['*'],
    details: {
      created:        new Date().toJSON(),
      lastModified:   new Date().toJSON()
    }
  }, true);
};

// Export Role
exports.Role = Role;

