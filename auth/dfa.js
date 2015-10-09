var _           = require('lodash');
var assert      = require('assert');
var Promise     = require('promise');
var ScopeResolver = require('./scoperesolver');


/** Sort roles by roleId, such that 'a*', comes right after 'a' */
let sortRolesForDFAGeneration = (roles) => {
  return roles.sort((a, b) => {
    let n = a.roleId.length;
    let m = b.roleId.length;
    if (n === m && a.roleId.startsWith(b.roleId.slice(0, -1))) {
      if (a.roleId[n - 1] === '*') {
        return -1;
      }
      if (b.roleId[n - 1] === '*') {
        return 1;
      }
    }
    if (a.roleId < b.roleId) {
      return -1;
    }
    return 1;
  });
};

// Export sortRolesForDFAGeneration
exports.sortRolesForDFAGeneration = sortRolesForDFAGeneration;

/**
 * Compare socpes a and b to see which comes first if sorted
 * Such that 'a*' comes before 'a', but otherwise normal order.
 */
let scopeCompare = (a, b) => {
  let n = a.length;
  let m = b.length;

  let d = Math.abs(n - m);
  if (d == 0) {
    if (a[n - 1] === '*' || b[n - 1] === '*') {
      if (a.startsWith(b.slice(0, -1))) {
        if (a[n - 1] === '*') {
          return -1;
        }
        if (b[n - 1] === '*') {
          return 1;
        }
      }
    }
  } else if (d == 1) {
    if (n > m && a[n - 1] === '*') {
      if (a.startsWith(b)) {
        return -1;
      }
    } else if (b[n - 1] === '*') {
      if (b.startsWith(a)) {
        return 1;
      }
    }
  }

  return a < b ? -1 : 1;
};

/** Assumes scopes to be unique, and sorts scopes for use with mergeScopeSets */
let sortScopesForMerge = (scopes) => {
  return scopes.sort(scopeCompare);
};

// Export sortScopesForMerge
exports.sortScopesForMerge = sortScopesForMerge;

/**
 * Take two sets of sorted scopes and merge them removing duplicates,
 * as well as scopes implied by a star-scopes.
 */
let mergeScopeSets = (scopes1, scopes2) => {
  let n = scopes1.length;
  let m = scopes2.length;
  let i = 0;
  let j = 0;
  let scopes = [];
  while (i < n && j < m) {
    let s1 = scopes1[i];
    let s2 = scopes2[j];
    let scope = null;
    if (s1 === s2) {
      scopes.push(s1);
      scope = s1;
      i += 1;
      j += 1;
    } else {
      let z = scopeCompare(s1, s2);
      if (z < 0) {
        scope = s1;
        scopes.push(s1);
        i += 1;
      } else {
        scope = s2;
        scopes.push(s2);
        j += 1;
      }
    }
    // If we just added a star scope, we have to skip everything that matches
    if (scope.endsWith('*')) {
      let prefix = scope.slice(0, -1);
      while(i < n && scopes1[i].startsWith(prefix)) {
        i += 1;
      }
      while(j < m && scopes2[j].startsWith(prefix)) {
        j += 1;
      }
    }
  }
  while (i < n) {
    let scope = scopes1[i];
    scopes.push(scope);
    i += 1;
    if (scope.endsWith('*')) {
      let prefix = scope.slice(0, -1);
      while(i < n && scopes1[i].startsWith(prefix)) {
        i += 1;
      }
    }
  }
  while (j < m) {
    let scope = scopes2[j];
    scopes.push(scope);
    j += 1;
    if (scope.endsWith('*')) {
      let prefix = scope.slice(0, -1);
      while(j < m && scopes2[j].startsWith(prefix)) {
        j += 1;
      }
    }
  }
  return scopes;
};

// Export mergeScopeSets
exports.mergeScopeSets = mergeScopeSets;

/**
 * Build a DFA of states on the form:
 * ```js
 * {
 *   'a': // next state if the current character is 'a'
 *   'end': [] // set of roles granted if the scope ends here
 *   'prefix': {...} // role granted if the scope matches so far
 * }
 * ```
 *
 * Must be started from: i = 0, n = roles.length, k = 0
 */
let generateDFA = (roles, i, n, k) => {
  var state = {};
  var role = roles[i];
  var current = role.roleId[k];
  var begin = i;
  // works because '' and '*' are sorted to top
  if (current === undefined) {
    state.end = [role];
    i += 1;
    if (i >= n) {
      return state;
    }
    role = roles[i];
    current = role.roleId[k];
  }
  if (current === '*' && role.roleId.length === k + 1) {
    state.prefix = role;
    i += 1;
    if (i >= n) {
      return state;
    }
    role = roles[i];
    current = role.roleId[k];
  }
  var start = i;
  while(i < n) {
    role = roles[i];
    var c = role.roleId[k];
    if (c !== current) {
      state[current] = generateDFA(roles, start, i, k + 1);
      current = c;
      start = i;
    }
    i += 1;
  }
  if (start !== i || !state.end) {
    state[current] = generateDFA(roles, start, i, k + 1);
  }
  var star = state['*'];
  if (!star) {
    state['*'] = star = {};
  }
  if (!state.prefix) {
    star.end = roles.slice(begin, n);
  } else {
    star.end = roles.slice(begin + 1, n);
    if (state.end) {
      star.end[0] = roles[begin];
    }
  }

  return state;
};

// Export generateDFA
exports.generateDFA = generateDFA;

/**
 * Builds a resolver that given a scope returns a set of roles.
 *
 * This also returns a lists of `sets`, where if you replace an entry in the
 * list of sets it'll be the return value from the resolver.
 */
let buildResolver = (roles) => {
  // Generate DFA
  roles = sortRolesForDFAGeneration(roles);
  let dfa = generateDFA(roles, 0, roles.length, 0);

  // Render a DFA state to code
  let renderDFA = (state, depth, impliedRoles, sets, i) => {
    var d = '';
    while (d.length < depth * 4) d += '    ';
    var c = '';
    c += d + 'switch(scope[' + depth + ']) {\n';
    if (state.prefix) {
      impliedRoles = [state.prefix].concat(impliedRoles);
      i = sets.push(impliedRoles) - 1;
    }
    var exactRoles = impliedRoles;
    var j = i;
    if (state.end) {
      exactRoles = state.end.concat(exactRoles);
      if (_.xor(exactRoles, sets[sets.length - 1]).length === 0) {
        j = sets.length - 1;
      } else {
        j = sets.push(exactRoles) - 1;
      }
    }
    c += d + '  case undefined:\n';
    c += d + '    return sets[' + j + '];\n';
    _.forEach(state, (s, character) => {
      if (character === 'prefix' || character === 'end') {
        return;
      }
      c += d + '  case \'' + character + '\':\n';
      c += renderDFA(s, depth + 1, impliedRoles, sets, i);
      c += d + '    break;\n';
    });
    c += d + '  default:\n';
    c += d + '    return sets[' + i + '];\n';

    c += d + '}\n';
    return c;
  };
  let sets = [[]];
  let body = renderDFA(dfa, 0, [], sets, 0);

  let resolver = new Function('sets', 'scope', body);
  resolver = resolver.bind(null, sets);
  return {sets, resolver: (scope) => {
      // Optimization so our DFA doesn't only has to operate on roleId
      if (scope.startsWith('assume:')) {
        return resolver(scope.slice(7));
      }
      if (scope.endsWith('*') && 'assume'.startsWith(scope.slice(0, -1))) {
        return resolver('*');
      }
      return sets[0];
    }
  };
};

// Export buildResolver
exports.buildResolver = buildResolver;

/**
 * Computes fixed point for roles and returns a resolver.
 * Will assume roles to be on the form `{roleId, scopes}`.
 * This will add the property `expandedScopes`, and internal properties
 * seen, impliedRoles that you should just disregard.
 *
 * The resolver returned will take a scope and return a set of scopes granted
 * by the scope. These will sorted such that they work with `mergeScopeSets`.
 */
let computeFixedPoint = (roles) => {
  // Add initial value for expandedScopes for each role R and sort roles
  for (let R of roles) {
    R.expandedScopes = null;
    R.scopes = sortScopesForMerge(R.scopes)
    R.impliedRoles = []; // roles that R can directly assume
    R.seen = 0; // later iteration this role was seen (used later)
  }

  let {resolver, sets} = buildResolver(roles);

  // Construct impliedRoles
  for(let R of roles) {
    for(let scope of R.scopes) {
      for(let role of resolver(scope)) {
        if (role !== R) {
          R.impliedRoles.push(role);
        }
      }
    }
  }

  // Construct expandedRoles as a fixed-point by traversing implied roles
  let iteration = 0;
  let traveseImpliedRoles = (R) => {
    let scopes = R.scopes;
    for (let r of R.impliedRoles) {
      if (r.seen < iteration) {
        r.seen = iteration;
        if (r.expandedScopes) {
          scopes = mergeScopeSets(scopes, r.expandedScopes);
        } else {
          scopes = mergeScopeSets(scopes, traveseImpliedRoles(r));
        }
      }
    }
    return scopes;
  };
  for (let R of roles) {
    iteration += 1;
    R.seen = iteration;
    R.expandedScopes = traveseImpliedRoles(R);
    R.impliedRoles = null;
  }

  // Update results sets of resolver to be scopes
  let n = sets.length;
  for (let i = 0; i < n; i++) {
    let scopes = [];
    for(let r of sets[i]) {
      scopes = mergeScopeSets(scopes, r.expandedScopes);
    }
    sets[i] = scopes;
  }

  return resolver;
};

// Export computeFixedPoint
exports.computeFixedPoint = computeFixedPoint;