var _           = require('lodash');
var assert      = require('assert');
var taskcluster = require('taskcluster-client');
var events      = require('events');
var base        = require('taskcluster-base');
var debug       = require('debug')('auth:ScopeResolver');

class ScopeResolver extends events.EventEmitter {
  /** Create ScopeResolver */
  constructor() {
    super();

    // List of client objects on the form:
    // {clientId, accessToken, expandedScopes: [...], updateLastUsed}
    this._clients       = [];
    // List of role objects on the form:
    // {roleId: '...', scopes: [...], expandedScopes: [...]}
    this._roles         = [];

    // Mapping from clientId to client objects from _clients:
    // {clientId, accessToken, expandedScopes: [...], updateLastUsed}
    this._clientCache   = {};
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
    assert(options.Client, "Expected options.Client");
    assert(options.Role, "Expected options.Role");
    assert(options.exchangeReference, "Expected options.exchangeReference");
    assert(options.connection instanceof taskcluster.PulseConnection,
           "Expected options.connection to be a PulseConnection object");
    this._Client        = options.Client;
    this._Role          = options.Role;
    this._options       = options;

    // Create authEvents client
    var AuthEvents = taskcluster.createClient(this._options.exchangeReference);
    var authEvents = new AuthEvents();

    // Create PulseListeners
    this._clientListener = new taskcluster.PulseListener({
      connection:   options.connection,
      reconnect:    true
    });
    this._roleListener = new taskcluster.PulseListener({
      connection:   options.connection,
      reconnect:    true
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

  async reloadClient(clientId) {
    let client = await this._Client.load({clientId}, true);
    // Always remove it
    this._clients = this._clients.filter(c => c.clientId !== clientId);
    // If a client was loaded add it back
    if (client) {
      // For reasoning on structure, see reload()
      let lastUsedDate = new Date(client.details.lastDateUsed);
      this._clients.push({
        clientId:       client.clientId,
        accessToken:    client.accessToken,
        updateLastUsed: lastUsedDate < taskcluster.fromNow('-6h')
      });
    }
    this._computeFixedPoint();
  }

  async reloadRole(roleId) {
    let role = await this._Role.load({roleId}, true);
    // Always remove it
    this._roles = this.roles.filter(r => r.roleId !== roleId);
    // If a role was loaded add it back
    if (role) {
      // For reasoning on structure, see reload()
      let scopes = _.union(role.scopes, ['assume:' + role.roleId]);
      this._roles.push({roleId: role.roleId, scopes});
    }
    this._computeFixedPoint();
  }

  async reload() {
    debug("Loading clients and roles");

    // Load clients and roles in parallel
    let clients = [];
    let roles   = [];
    await Promise.all([
      // Load all clients on a simplified form:
      // {clientId, accessToken, updateLastUsed}
      // _computeFixedPoint() will construct the `_clientCache` object
      this._Client.scan({}, {
        handler: client => {
          let lastUsedDate = new Date(client.details.lastDateUsed);
          clients.push({
            clientId:       client.clientId,
            accessToken:    client.accessToken,
            // Note that lastUsedDate should be updated, if it's out-dated by more
            // than 6 hours (cheap way to know if it's been used recently)
            updateLastUsed: lastUsedDate < taskcluster.fromNow('-6h')
          });
        }
      }),
      // Load all roles on a simplified form: {roleId, scopes}
      // _computeFixedPoint() will later add the `expandedScopes` property
      this._Role.scan({}, {
        handler(role) {
          // Ensure identity... Basically, make sure that role also has the scope
          // that guards it. This is important as it ensures that fixed-point
          // computation below will saturate cases where another guard matches it.
          let scopes = _.union(role.scopes, ['assume:' + role.roleId]);
          roles.push({roleId: role.roleId, scopes});
        }
      })
    ]);


    // Set _roles and _clients at the same time and immediately call
    // _computeFixedPoint, so anyone using the cache is using a consistent one.
    this._roles = roles;
    this._clients = clients;
    this._computeFixedPoint();
  }

  /** Compute fixed point over this._roles, and construct _clientCache */
  _computeFixedPoint() {
    // Add initial value for expandedScopes for each role R
    for (let role of this._roles) {
      role.expandedScopes = _.clone(role.scopes);
    }

    // Compute fixed-point of roles.expandedScopes for each role R
    for (let R of this._roles) {
      let isFixed = false;
      while (!isFixed) {
        isFixed = true; // assume we have fixed point
        for (let role of this._roles) {
          // if R can assume role, then we union the scope sets, as there is a
          // finite number of strings here this will reach a fixed-point
          let test = (scope) => ScopeResolver.grantsRole(scope, role.roleId);
          if (R.expandedScopes.some(test)) {
            let count = R.expandedScopes.length;
            R.expandedScopes = _.union(R.expandedScopes, role.expandedScopes);
            // Update isFixed, if scopes were added we need a extra round for
            // proof that we have a fixed point
            isFixed = isFixed && count == R.expandedScopes.length;
          }
        }
      }
    }

    // Compress scopes (removing scopes covered by other star scopes)
    for(let role of this._roles) {
      role.expandedScopes = ScopeResolver.normalizeScopes(role.expandedScopes);
    }

    // Construct client cache
    this._clientCache = {};
    for (let client of this._clients) {
      var scopes = this.resolve(['assume:client-id:' + client.clientId]);
      client.scopes = scopes; // for createSignatureValidator compatibility
      client.expandedScopes = scopes;
      this._clientCache[client.clientId] = client;
    }
  }

  /** Update lastDateUsed for a clientId */
  async _updateLastUsed(clientId) {
    let client = await this._Client({clientId});
    await client.modify(client => {
      let lastUsedDate = new Date(client.details.lastDateUsed);
      if (lastUsedDate < taskcluster.fromNow('-6h')) {
        client.details.lastDateUsed = new Date().toJSON();
      }
    });
  }

  /**
   * Return set of scopes that `scopes` can be expanded to when assuming all
   * authorized roles.
   */
  resolve(scopes) {
    for (let scope of scopes) {
      // Skip scopes that doesn't cover "assume:", this is just a quick
      // under-approximation
      if (!scope.startsWith('assume:') && !scope.endsWith('*')) {
        continue;
      }

      // For each role, expand if the role can be assumed, note we don't need to
      // traverse the scopes added... As we the fixed-point for all roles.
      for (let role of this._roles) {
        if (ScopeResolver.grantsRole(scope, role.roleId)) {
          scopes = _.union(scopes, role.scopes);
        }
      }
    }
    return ScopeResolver.normalizeScopes(scopes);
  }

  createSignatureValidator(options = {}) {
    let validator = base.API.createSignatureValidator({
      nonceManager: options.clientLoader,
      clientLoader: async (clientId) => {
        let client = this._clientCache[clientId];
        if (!client) {
          throw new Error("Client with clientId: '" + clientId + "' not found");
        }
        if (client.updateLastUsed) {
          client.updateLastUsed = false;
          this._updateLastUsed(clientId).catch(err => this.emit('error', err));
        }
        return client;
      }
    });
    return (req) => {
      return validator(req).then(result => {
        if (result.status === 'auth-success') {
          // This is only necessary if authorizedScopes or temporary credentials
          // was used, otherwise it should already be the fixed-point.
          // We should refactor base.API.createSignatureValidator to facilitate
          // this... But for now this is okay...
          result.scopes = this.resolve(result.scopes);
        }
        return result;
      });
    };
  }

  /**
   * Remove scopes that aren't needed, e.g. if you have ["q:1", "q:*"], then
   * the scope-set ["q:*"] is the formal-form. Basically shorter, but same
   * level of authority.
   */
  static normalizeScopes(scopes) {
    // Filter out any duplicate scopes (so we only have unique strings)
    scopes = _.uniq(scopes);
    // Filter out scopes that are covered by some other scope
    return scopes.filter(scope => {
      return !scopes.some(other => {
        // If `scope` is `other`, then we can't filter it! It has to be
        // strictly greater than (otherwise scopes would filter themselves)
        if (other === other) {
          return false;
        }
        // But if the other one ends with '*' and `scope` starts with its
        // prefix then `other` is strictly greater than `scope` and we filter
        // out `scope`.
        return other.endsWith('*') && scope.startsWith(other.slice(0, -1));
      });
    });
  }

  /** Determine if scope grants a roleId, and allows owner to assume the role */
  static grantsRole(scope, roleId) {
    // We have 3 rules (A), (B) and (C) by which a scope may match a role.
    // This implementation focuses on being reasonably fast by avoiding
    // allocations whenever possible.

    // Rule (A) and (B) both requires the scope to start with "assume:"
    if (scope.startsWith('assume:')) {
      // A) We have scope = 'assume:<roleId>', so we can assume the role
      if (scope.length === roleId.length + 7 && scope.endsWith(roleId)) {
        return true;
      }

      // B) guard is on the form 'assume:<prefix>*' and we have a scope on the
      //    form 'assume:<prefix>...'. This is special rule, assigning
      //    special meaning to '*' when used at the end of a roleId.
      if (roleId.endsWith('*') && scope.slice(7).startsWith(roleId.slice(0, -1))) {
        return true;
      }
    }

    // C) We have scope as '<prefix>*' and '<prefix>' is a prefix of guard, this
    //    is similar to rule (A) relying on the normal scope satisfiability.
    if (scope.endsWith('*') && roleId.startsWith(scope.slice(7, -1))) {
      return true;
    }
    return false;
  }
}

// Export ScopeResolver
module.exports = ScopeResolver;
