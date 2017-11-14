var _           = require('lodash');
var assert      = require('assert');
var taskcluster = require('taskcluster-client');
var events      = require('events');
var debug       = require('debug')('auth:ScopeResolver');
var Promise     = require('promise');
var {scopeCompare, mergeScopeSets, normalizeScopeSet} = require('taskcluster-lib-scopes');
var {generateTrie, executeTrie} = require('./trie');

class ScopeResolver extends events.EventEmitter {
  /** Create ScopeResolver */
  constructor(options = {}) {
    super();

    // Provide default options
    options = _.defaults({}, options, {
      // Maximum time that lastUsed must be behind, must always be negative
      maxLastUsedDelay: '-6h',
    });
    this._maxLastUsedDelay = options.maxLastUsedDelay;
    assert(/^ *-/.test(options.maxLastUsedDelay),
      'maxLastUsedDelay must be negative');

    // List of client objects on the form:
    // {
    //    clientId, accessToken,
    //    unexpandedScopes:             // Scopes (as set in the table)
    //    disabled: true | false,       // If true, client is disabled
    //    scopes: [...],                // Scopes (including indirect scopes)
    //    expires: new Date(),          // The client's expiration timestamp
    //    expandedScopes: [...],        // Scopes (including indirect scopes)
    //    updateLastUsed: true | false  // true, if lastUsed should be updated
    // }
    this._clients = [];
    // List of role objects on the form:
    // {roleId: '...', scopes: [...]}
    this._roles = [];

    // Mapping from clientId to client objects from _clients,
    // _clientCache[clientId] === this._clients[i] === {     // for some i
    //   clientId, accessToken, expandedScopes: [...], updateLastUsed
    // };
    this._clientCache = {};

    // Promise that we're done reloading, used to serialize reload operations
    this._reloadDone = Promise.resolve();
  }

  /**
   * Load cache, setup interval for reloading cache, start listening
   *
   * options:
   * {
   *   Client:              // data.Client object
   *   Role:                // data.Role object
   *   connection:          // PulseConnection object
   *   exchangeReference:   // reference for exchanges declared
   *   cacheExpiry:         // Time before clearing cache
   * }
   */
  async setup(options) {
    options = _.defaults({}, options || {}, {
      cacheExpiry:    20 * 60 * 1000,   // default to 20 min
    });
    assert(options.Client, 'Expected options.Client');
    assert(options.Role, 'Expected options.Role');
    assert(options.exchangeReference, 'Expected options.exchangeReference');
    assert(options.connection instanceof taskcluster.PulseConnection,
      'Expected options.connection to be a PulseConnection object');
    this._Client        = options.Client;
    this._Role          = options.Role;
    this._options       = options;

    // Create authEvents client
    var AuthEvents = taskcluster.createClient(this._options.exchangeReference);
    var authEvents = new AuthEvents();

    // Create PulseListeners
    this._clientListener = new taskcluster.PulseListener({
      connection:   options.connection,
      reconnect:    true,
    });
    this._roleListener = new taskcluster.PulseListener({
      connection:   options.connection,
      reconnect:    true,
    });

    // listen for client events
    await this._clientListener.bind(authEvents.clientCreated());
    await this._clientListener.bind(authEvents.clientUpdated());
    await this._clientListener.bind(authEvents.clientDeleted());
    // listen for role events
    await this._roleListener.bind(authEvents.roleCreated());
    await this._roleListener.bind(authEvents.roleUpdated());
    await this._roleListener.bind(authEvents.roleDeleted());

    // Reload when we get message
    this._clientListener.on('message', m => {
      return this.reloadClient(m.payload.clientId);
    });
    this._roleListener.on('message', m => {
      return this.reloadRole(m.payload.roleId);
    });

    // Load initially
    await this.reload();

    // Set this.reload() to run repeatedly
    this._reloadIntervalHandle = setInterval(() => {
      this.reload().catch(err => this.emit('error', err));
    }, this._options.cacheExpiry);

    // Start listening
    await this._clientListener.resume();
    await this._roleListener.resume();
  }

  /** Update lastDateUsed for a clientId */
  async _updateLastUsed(clientId) {
    let client = await this._Client.load({clientId});
    await client.modify(client => {
      let lastUsedDate = new Date(client.details.lastDateUsed);
      let minLastUsed = taskcluster.fromNow(this._maxLastUsedDelay);
      if (lastUsedDate < minLastUsed) {
        client.details.lastDateUsed = new Date().toJSON();
      }
    });
  }

  /**
   * Execute async `reloader` function, after any earlier async `reloader`
   * function given this function has completed. Ensuring that the `reloader`
   * functions are executed in serial.
   */
  _syncReload(reloader) {
    return this._reloadDone = this._reloadDone.catch(() => {}).then(reloader);
  }

  reloadClient(clientId) {
    return this._syncReload(async () => {
      let client = await this._Client.load({clientId}, true);
      // Always remove it
      this._clients = this._clients.filter(c => c.clientId !== clientId);
      // If a client was loaded, add it back
      if (client) {
        // For reasoning on structure, see reload()
        let lastUsedDate = new Date(client.details.lastDateUsed);
        let minLastUsed = taskcluster.fromNow(this._maxLastUsedDelay);
        this._clients.push({
          clientId:         client.clientId,
          accessToken:      client.accessToken,
          expires:          client.expires,
          updateLastUsed:   lastUsedDate < minLastUsed,
          unexpandedScopes: client.scopes,
          disabled:         client.disabled,
        });
      }
      this._rebuildResolver();
    });
  }

  reloadRole(roleId) {
    return this._syncReload(async () => {
      let role = await this._Role.load({roleId}, true);
      // Always remove it
      this._roles = this._roles.filter(r => r.roleId !== roleId);
      // If a role was loaded add it back
      if (role) {
        this._roles.push({roleId: role.roleId, scopes: role.scopes});
      }
      this._rebuildResolver();
    });
  }

  reload() {
    return this._syncReload(async () => {
      debug('Loading clients and roles');

      // Load clients and roles in parallel
      let clients = [];
      let roles   = [];
      await Promise.all([
        // Load all clients on a simplified form:
        // {clientId, accessToken, updateLastUsed}
        // _rebuildResolver() will construct the `_clientCache` object
        this._Client.scan({}, {
          handler: client => {
            let lastUsedDate = new Date(client.details.lastDateUsed);
            let minLastUsed = taskcluster.fromNow(this._maxLastUsedDelay);
            clients.push({
              clientId:         client.clientId,
              accessToken:      client.accessToken,
              expires:          client.expires,
              // Note that lastUsedDate should be updated, if it's out-dated by
              // more than 6 hours.
              // (cheap way to know if it's been used recently)
              updateLastUsed:   lastUsedDate < minLastUsed,
              unexpandedScopes: client.scopes,
              disabled:         client.disabled,
            });
          },
        }),
        // Load all roles on a simplified form: {roleId, scopes}
        this._Role.scan({}, {
          handler(role) {
            roles.push({roleId: role.roleId, scopes: role.scopes});
          },
        }),
      ]);

      // Set _roles and _clients at the same time and immediately call
      // _rebuildResolver, so anyone using the cache is using a consistent one
      this._roles = roles;
      this._clients = clients;
      this._rebuildResolver();
    });
  }

  /** Compute fixed point over this._roles, and construct _clientCache */
  _rebuildResolver() {
    this._resolver = this.buildResolver(this._roles);

    // Construct client cache
    this._clientCache = {};
    for (let client of this._clients) {
      var scopes = this.resolve(client.unexpandedScopes);
      client.scopes = scopes; // for createSignatureValidator compatibility
      client.expandedScopes = scopes;
      this._clientCache[client.clientId] = client;
    }
  }

  /**
   * Build a resolver which, given a set of scopes, will return the expanded
   * set of scopes based on the given roles.  Roles are an array of elements
   * {roleId, scopes}.
   */
  buildResolver(roles) {
    let rules = roles.map(({roleId, scopes}) => {
      let pattern = `assume:${roleId}`;
      return {pattern, scopes};
    });

    let dfa = generateTrie(rules);
    const assumePrefix = /^(:?(:?|a|as|ass|assu|assum|assum|assume)\*$|assume:)/;

    return (inputs) => {
      let scopes = inputs;
      let seen = new Set();
      let i = 0;
      while (i < scopes.length) {
        let scope = scopes[i++];
        // if this scope is not going to expand, ignore it
        if (!assumePrefix.test(scope)) {
          continue;
        }
        // if we have seen this scope, ignore it
        if (seen.has(scope)) {
          continue;
        }
        seen.add(scope);
        // (for the moment, ignore the indexed return style of executeTrie)
        scopes = scopes.concat(_.flatten(executeTrie(dfa, scope)).filter(e => e));
      }

      // normalize the resulting set of scopes
      scopes.sort(scopeCompare);
      return normalizeScopeSet(scopes);
    };
  };

  /**
   * Return a normalized set of scopes that `scopes` can be expanded to when
   * assuming all authorized roles.
   */

  resolve(scopes) {
    return this._resolver(scopes);
  }

  async loadClient(clientId) {
    let client = this._clientCache[clientId];
    if (!client) {
      throw new Error('Client with clientId \'' + clientId + '\' not found');
    }
    if (client.disabled) {
      throw new Error('Client with clientId \'' + clientId + '\' is disabled');
    }
    if (client.expires < new Date()) {
      throw new Error('Client with clientId: \'' + clientId + '\' has expired');
    }

    if (client.updateLastUsed) {
      client.updateLastUsed = false;
      this._updateLastUsed(clientId).catch(err => this.emit('error', err));
    }
    return client;
  }

  /**
   * Remove scopes that aren't needed, e.g. if you have ["q:1", "q:*"], then
   * the scope-set ["q:*"] is the formal-form. Basically shorter, but same
   * level of authority.
   */
  static normalizeScopes(scopes) {
    //return scopes;
    // Filter out any duplicate scopes (so we only have unique strings)
    scopes = _.uniq(scopes);
    // Filter out scopes that are covered by some other scope
    return scopes.filter(scope => {
      return scopes.every(other => {
        // If `scope` is `other`, then we can't filter it! It has to be
        // strictly greater than (otherwise scopes would filter themselves)
        if (other === scope) {
          return true;
        }
        // But if the other one ends with '*' and `scope` starts with its
        // prefix then `other` is strictly greater than `scope` and we filter
        // out `scope`.
        return !(other.endsWith('*') && scope.startsWith(other.slice(0, -1)));
      });
    });
  }
}

// Export ScopeResolver
module.exports = ScopeResolver;
