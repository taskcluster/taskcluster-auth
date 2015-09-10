var _           = require('lodash');
var assert      = require('assert');
var data        = require('./data');
var taskcluster = require('taskcluster-client');
var events      = require("events");

class ScopeResolver extends events.EventEmitter {
  /**
   * Create scope resolver
   *
   * options:
   * {
   *   Client:              // data.Client object
   *   Role:                // data.Role object
   *   connection:          // PulseConnection object
   *   exchangePrefix:      // Prefix for exchanges monitored
   *   cacheExpiry:         // Time before clearing cache
   *   minReloadDelay:      // Minimum delay between reloads
   * }
   *
   */
  constructor(options) {
    super();
    options = _.defaults({}, options || {}, {
      cacheExpiry:    10 * 60 * 1000,   // default to 10 min
      minReloadDelay:  1 * 60 * 1000,   // default to 1 min
    });
    assert(options.Client instanceof data.Client,
           "Expected options.Client to be an instance of data.Client");
    assert(options.Role instanceof data.Role,
           "Expected options.Role to be an instance of data.Role");
    assert(options.connection instanceof taskcluster.PulseConnection,
           "Expected options.connection to be a PulseConnection object");
    this._Client        = options.Client;
    this._Role          = options.Role;
    this._connection    = options.connection;
    this._listener      = null;
    this._reloadTimeout = null;
    this._lastReload    = Date.now();
    this._options       = options;
    // Mapping from clientId to client objects on the form
    // {clientId, accessToken, scopes: [...], updateLastUsed: true || false}
    this._clientCache   = {};
    // List of role objects on the form:
    // {roleId: '...', scopes: [...]}
    this._roleCache     = [];
  }

  /** Reload cache, setup interval for reloading cache, start listening */
  async setup() {
    // Create authEvents client
    var authEvents = new taskcluster.AuthEvents({
      exchangePrefix: this._options.exchangePrefix
    });

    // Create PulseListener
    this._listener = new taskcluster.PulseListener({
      connection:   this._connection,
      reconnect:    true
    });

    // listen for events that causes us to reload
    await this._listener.bind(authEvents.clientCreated());
    await this._listener.bind(authEvents.clientUpdated());
    await this._listener.bind(authEvents.clientDeleted());
    await this._listener.bind(authEvents.roleCreated());
    await this._listener.bind(authEvents.roleUpdated());
    await this._listener.bind(authEvents.roleDeleted());

    // Reload when we get message
    this._listener.on('message', () => this.reload());

    // Start listening
    await this._listener.resume();

    // Load initially
    await this.reload();
  }

  async reload() {
    // Clear whatever timeout is currently set
    clearTimeout(this._reloadTimeout);
    this._reloadTimeout = null;

    // If we reload now, then by default we reload again after cacheExpiry
    var reloadIn = this._options.cacheExpiry;

    // If timeSinceLastReload is greater than minimum, then we reload now
    var timeSinceLastReload = Date.now() - this._lastReload;
    if (timeSinceLastReload > this._options.minReloadDelay) {
      // We set this here, so that if someone calls reload() again, then they'll
      // go to the else branch... Unless sufficient time has passed...
      this._lastReload = Date.now();
      await this._loadCache().catch(err => this.emit('error', err));
    } else {
      // If last reload wasn't long enough ago, we change reloadIn and then
      // a new reload will be scheduled instead...
      reloadIn = this._options.minReloadDelay - timeSinceLastReload;
    }

    // If there is not reloadTimeout we schedule one... This can happen if we
    // have two calls to reload() shortly after each-other, then the second
    // branch of the if-statement above can return faster than the blocking
    // _loadCache() call...
    if (!this._reloadTimeout) {
      this._reloadTimeout = setTimeout(() => this.reload(), reloadIn);
    }
  }

  async _loadCache() {
    // Load all clients
    let clients = [];
    await this._Client.scan({}, {
      handler: client => clients.push(client)
    });

    // Load all roles on a simplified form: {roleId, scopes}
    let roles = [];
    await this._Role.scan({}, {
      handler(role) {
        // Ensure identity... Basically, make sure that role also has the scope
        // that guards it. This is important as it ensures that fixed-point
        // computation below will saturate cases where another guard matches it.
        let scopes = _.union(role.scopes, ['assume:' + role.roleId]);
        roles.push({roleId: roleId, scopes});
      }
    });

    // Ensure there is a role for each clientId
    for (let {clientId} of clients) {
      let roleId = 'client-id:' + clientId;
      if (!_.some(roles, {roleId})) {
        // Create the identity role for each clientId. This is important as we
        // may have another role with the guard: "assume:client-id:<prefix>*"
        // where <prefix> is a prefix of clientId, in which case the clientId
        // will be able to assume scopes from the role.
        roles.push({roleId, scopes: ['assume:' + roleId]});
      }
    }

    // Compute fixed-point of roles.scopes for each role R
    for (let R of roles) {
      let isFixed = false;
      while (!isFixed) {
        isFixed = true; // assume we have fixed point
        for (let role of roles) {
          // if R can assume role, then we union the scope sets, as there is a
          // finite number of strings here this will reach a fixed-point
          let test = (scope) => ScopeResolver.grantsRole(scope, role.roleId);
          if (R.scopes.some(test)) {
            let count = R.scopes.length;
            R.scopes = _.union(R.scopes, role.scopes);
            // Update isFixed, if scopes were added we need a extra round for
            // proof that we have a fixed point
            isFixed = isFixed && count == R.scopes.length;
          }
        }
      }
    }

    // Compress scopes (removing scopes covered by other star scopes)
    for(let role of roles) {
      role.scopes = ScopeResolver.normalizeScopes(role.scopes);
    }

    // Set role cache
    this._roleCache = roles;

    // Construct client cache
    this._clientCache = {};
    for (let client of clients) {
      let lastUsedDate = new Date(client.details.lastDateUsed);
      this._clientCache[client.clientId] = {
        clientId:       client.clientId,
        accessToken:    client.accessToken,
        scopes:         _.find(roles, {roleId: 'client-id:' + clientId}) || [],
        // Note that lastUsedDate should be updated, if it's out-dated by more
        // then 6 hours (cheap way to know if it's been used recently)
        updateLastUsed: lastUsedDate < taskcluster.fromNow('-6h')
      };
    }
  }

  /** Update lastDateUsed for a clientId */
  async _updateLastUsed(clientId) {
    let client = await this._Client(clientId);
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
      for (let role of this._roleCache) {
        if (ScopeResolver.grantsRole(scope, roleId)) {
          scopes = _.union(scopes, role.scopes);
        }
      }
    }
    return ScopeResolver.normalizeScopes(scopes);
  }

  createSignatureValidator(options = {}) {
    let validator = base.API.createSignatureValidator({
      nonceManager: options.clientLoader,
      clientLoader: (clientId) => {
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
