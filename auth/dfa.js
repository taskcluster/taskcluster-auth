var _           = require('lodash');
var assert      = require('assert');
var Promise     = require('promise');
var ScopeResolver = require('./scoperesolver');

/**
 * Sort roles by roleId, such that 'a*', comes right after 'a'
 *
 * Example: ['', 'a', 'a*', 'a(', 'aa', 'b'] is a list sorted as such.
 * Notice that the difference from a normal sorted list is only that '*'
 * comes before any other characters. Normally 'a(' would come before 'a*',
 * but not here.
 *
 * We do this such that we get a list looking a but like this:
 *  1. client-id:a
 *  2. client-id:try
 *  3. client-id:try*
 *  4. client-id:try-more
 *  5. client-id:z
 *
 * The cool thing is that when generating a DFA for this list all the possible
 * candidates (1-5) have the same path until we reach the 11th character.
 * At the 11th character the string diverge and any DFA constructed must
 * naturally have more than one state. However, for 11th character our DFA still
 * only needs 3 states, one representing (1), (2-4) and (5). But sorting the
 * list of roles, we represent these subsets elegantly and efficiently using
 * array offsets in the list of roles.
 *
 * More details on this later, for now just know that it makes DFA construct
 * both efficient and elegant (not to mention easy).
 */
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
 * Compare scopes a and b to see which comes first if sorted
 * Such that 'a*' comes before 'a', but otherwise normal order.
 *
 * Example: ['*', '', 'a*', 'a', 'a(', 'aa', 'b'] is a list sorted as such.
 *
 * Notice that this is different from `sortRolesForDFAGeneration` as '*' comes
 * before the empty string.
 *
 * The reasoning for this sorting is pretty simple. If we have a set of scopes:
 *   ['a', 'a*', 'ab', 'b']
 * We wish to normalize the scope sets while merging, such that we don't have
 * duplicates and redundant scopes. If we sort the set of scopes above we get:
 *   ['a*', 'a', 'ab', 'b']
 * Now if we wish to construct the normalized scope-set, we just takes the
 * scopes out of the list one by one in the sorted order. And if the last scope
 * added the to normalized result list doesn't satisfy the current scope, the
 * current scope is added to the result list.
 *
 * Formally, we say that a scope-set S is normalized if there is not two scopes
 * a, b in S such that a satisfies b.
 *
 * On the above list, normalization would look like this:
 *   R = []                       // Normalized result list
 *   S = ['a*', 'a', 'ab', 'b']   // Sorted input list
 *   L = null                     // Last normalized scope
 * Step 1:
 *   'a*' = S[0]
 *   does L satisfy 'a*', answer: NO
 *   R.push('a*')
 *   L = 'a*'
 * Step 2:
 *   'a' = S[1]
 *   does L satisfy 'a', answer: YES (L = 'a*')
 *   Then we skip 'a'
 * Step 3:
 *   'ab' = S[2]
 *   does L satisfy 'ab', answer: YES (L = 'a*')
 *   Then we skip 'ab'
 * Step 4:
 *   'b' = S[3]
 *   does L satisfy 'b', answer: NO (L = 'a*')
 *   R.push('b')
 *   L = 'b'
 * Done:
 *   R, satisfies all the scopes in S, but it's smaller, and doesn't have any
 *   duplicates, or scopes that satisfies other scopes.
 *
 * We perform normalization in the process of merging scope sets; see below.
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
 * Take two sets of sorted scopes and merge them, normalizing in the process.
 * Normalizing means removing duplicates, as well as scopes implied by a
 * star-scopes.
 *
 * This method returns a new array, and leaves both arguments untouched.
 * Hence, you should not clone arrays prior to calling this method.
 *
 * Returns a set of normalized scopes. See scopeCompare for formal definition
 * for normalized scope-set.
 */
let mergeScopeSets = (scopes1, scopes2) => {
  // This is dead simple, we track the length with n and m
  let n = scopes1.length;
  let m = scopes2.length;
  // And we track the current offset in the scopes1 and scopes2 using
  // i and j respectfully. This ensure that we don't have modify the arguments.
  let i = 0;
  let j = 0;
  let scopes = [];
  while (i < n && j < m) {
    // Take a scope for each list
    let s1 = scopes1[i];
    let s2 = scopes2[j];
    let scope = null;
    if (s1 === s2) {
      // If the two scopes are exactly the same, then we add one of them
      // and we increment both i and j by one.
      scopes.push(s1);
      scope = s1;
      i += 1;
      j += 1;
    } else {
      // If the scopes are different, we compare them using the function used
      // for the sort order and choose the one that comes first.
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
    // If we just added a star scope, we have to skip everything that
    // is satisfied by the star scope.
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
  // At this stage i = n or j = m, meaning that one of our two lists is now
  // empty, so we just add everything from one of them. But to ensure
  // normalization, we still do the endsWith('*') trick, skipping scopes that
  // are already satisfied.
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
 * Build a DFA of states of the form:
 * ```js
 * {
 *   'a': { ... }// next state if the current character is 'a'
 *   'end': [] // set of roles granted if the scope ends here
 *   'prefix': ... // role granted if the scope matches so far (but recognition
 *                 // should continue)
 * }
 * ```
 *
 * Given a set of roles, we want to build a recognizer that will match a given
 * scope against those roles, including support for the kleen star (`*`) in the
 * scope and in the roles.  When a scope is recognized, it should be trivial to
 * read off the set of matched roles.
 *
 * If we recall basic language theory we know that DFAs can recognize all
 * regular languages. Constructing a DFA for a regular language is, however, not
 * trivial. Typically regular languages are expressed as regular expressions,
 * and indeed the kleene star in our roleIds is similar to /.*$/. The classic
 * approach involves constructing an NFA from your regular expression, then
 * if transforming to a DFA and minimizing the DFA. This doesn't really work for
 * us as the NFA to DFA and DFA minimization operations are quiet expensive.
 *
 * However, we don't need to the full expressiveness of regular expressions. If
 * We consider the following set roleIds:
 *  1. a
 *  2. b
 *  3. b*
 *  4. bc
 *  5. c
 *
 * The quick reader may observe that when represented like this we may
 * represent each state of a DFA as character index k, start i and end n offset
 * in the list of possible roleIds matched.  Indeed the generateDFA(roles, i,
 * n, k) function generates a DFA state for roles[i:n] matching character at
 * index k.
 *
 * If we take the roleIds above and generate the DFA state using the generateDFA
 * function below we will get a structure as follows:
 * ```js
 * { 'a': { end: ['a'] },
 *   'b': { end: ['b'],
 *          prefix: 'b*',
 *          'c': { end: ['bc'] },
 *          '*': { end: ['b', 'bc'] } },
 *   'c': { end: ['c'] },
 *   '*': { end: [ 'a', 'b', 'b*', 'bc', 'c' ] } }
 * ```
 *
 * The state is not accepting and has four transitions for 'a', 'b', 'c', and
 * '*'.  If we look at the state following an 'a' transition, we see the state:
 *   `{end: ['a']}`
 * This is an accepting state, if the scope being scanned ends here then it
 * matches the roleId: 'a'.
 *
 * If we look at the state following a 'b' transition we again see an accepting
 * state, but there is also a transition on 'c' to the state '{end: ['c']}`.
 * Another interesting thing with the state following 'b' is that the scope
 * being scanned has matched the roleId: 'b*'. This is indicated with the
 * `prefix: 'b*'` property. This property is intended to indicate that no matter
 * what is matched after this, the roleId: 'b*' have definitely been matched and
 * should be returned. We do this for efficiency, rather than remembering the
 * list of non-terminal roleIds matched so far and creating a state for each
 * unmatched transition. This little hack, also means that we don't need any
 * cycles in our DFA.
 *
 * Must be started from: i = 0, n = roles.length, k = 0
 */
let generateDFA = (roles, i, n, k) => {
  var state = {};
  var role = roles[i];
  var current = role.roleId[k];
  var begin = i;
  // Recall that because '' and '*' are sorted to top
  if (current === undefined) {
    // If current character is undefined (meaning end of string)
    // then this is an accepting state for the terminal roleId assigned to role.
    state.end = [role];
    // We skip role and continue as we would have without it
    i += 1;
    if (i >= n) {
      return state;
    }
    role = roles[i];
    current = role.roleId[k];
  }
  // If current character is a kleene star and the roleId ends here, then
  // we have already matched a prefix role, and set the prefix property so that
  // when this is evaluated we know the prefix roleId has been matched.
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
    // Here we go through the roles in the sorted order given, and whenever we
    // encounter a new character we generate a DFA state for it, giving it the
    // start and end-offset in the roles list of when we first saw the character
    // and when it ended.
    if (c !== current) {
      state[current] = generateDFA(roles, start, i, k + 1);
      current = c;
      start = i;
    }
    i += 1;
  }
  // Same as inside the loop, just for the last character, if there is one.
  if (start !== i || !state.end) {
    state[current] = generateDFA(roles, start, i, k + 1);
  }
  // There must always be a transition for the '*', if it is matched in the
  // scope we're scanning then we must to a state where the if the state ends
  // you get all the roles is the current sub-tree. This is because '*' at the
  // very end of a scope grants all the scopes matching it up to that '*'.
  var star = state['*'];
  if (!star) {
    state['*'] = star = {};
  }

  // of the set of roles in [begin, n], include all but the nonterminal role
  // (the one ending in *)
  if (!state.prefix) {
    star.end = roles.slice(begin, n);
  } else {
    // skip the first role
    star.end = roles.slice(begin + 1, n);
    // but if the nonterminal role was second, replace it with the first
    if (state.end) {
      star.end[0] = roles[begin];
    }
  }

  return state;
};

// Export generateDFA
exports.generateDFA = generateDFA;

/**
 * Builds a pair {resolver, sets} where sets is a list of lists of roles,
 * and given a scope `resolver(scope)`` returns a list from sets.
 *
 * That definition sounds slightly complicated, it's actually very simple,
 * sets is on the form:
 * ```js
 * sets = [
 *   [{role}, ...],
 *   [{role}, ...],
 *   [{role}, ...]
 * ]
 * ```
 *
 * And `resolver(scope)` returns `sets[i]` for some `i` s.t. `sets[i]` is the
 * list of roles matched by `scope`. We do it like this, as `sets` may be
 * modified from containing lists of roles, to containing lists of scopes, when
 * we've computed the fixed-point and knows what set of scopes a each role
 * grants both directly and indirectly.
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
    // In each state we switch on the `scope` variable at the given depth.
    c += d + 'switch(scope[' + depth + ']) {\n';
    if (state.prefix) {
      // If at the current state we've already matched some non-terminal roleId
      // (a roleId ending with '*') we add this to the set of implied roles and
      // we add this set of implied to set of possible results, the `sets`
      // variable and then we remember its offset.
      impliedRoles = [state.prefix].concat(impliedRoles);
      i = sets.push(impliedRoles) - 1;
      // TODO: If we wish to optimize further and better handle degenerate cases
      // we could optimize this further by allowing impliedRoles, exactRoles as
      // computed below and generally all entries in `sets` to be lists of lists
      // of lists... of roles. Basically allows infinite number of array
      // wrappers. The extra wrappers wouldn't imply new semantics and
      // flattening then with _.flattenDeep() would be completely valid.
      // The aim would be to avoid construction of new arrays contains all the
      // roles by using [state.prefix, impliedRoles] instead of using:
      //   [state.prefix].concat(impliedRoles)
      // Further more it speed up the computation of sets[i] as lists of scopes
      // in computeFixedPoint()
    }
    var exactRoles = impliedRoles;
    var j = i;
    if (state.end) {
      // if the current state is a terminal state, we create a set of roles
      // granted if the string ends here. Before we insert this set in the
      // `sets` variable, we check with the last entry in the `sets` array to
      // see if it matches the current set. If so we don't have to insert, but
      // can instead just return the current set.
      exactRoles = state.end.concat(exactRoles);
      if (_.xor(exactRoles, sets[sets.length - 1]).length === 0) {
        j = sets.length - 1;
      } else {
        j = sets.push(exactRoles) - 1;
      }
    }
    // if the current character is undefined we return sets[j] where j is the
    // of set of exactRoles as computed above if this is a terminal state.
    // Otherwise, we have i = j and sets[i] is the set of implied roles
    // collected while traversing to this state...
    c += d + '  case undefined:\n';
    c += d + '    return sets[' + j + '];\n';
    _.forEach(state, (s, character) => {
      if (character === 'prefix' || character === 'end') {
        return;
      }
      // For each key of the state object that isn't 'prefix' or 'end' we have
      // a transition to another state. So we render the switch for that DFA.
      c += d + '  case \'' + character + '\':\n';
      c += renderDFA(s, depth + 1, impliedRoles, sets, i);
      c += d + '    break;\n';
    });
    // If we have no matches then we just return the roles implied so far..
    c += d + '  default:\n';
    c += d + '    return sets[' + i + '];\n';

    c += d + '}\n';
    return c;
  };
  // Initially the implied roles is the empty set [] == sets[0], which is why
  // we call with sets = [[]] and i = 0. Obviously, we start at character offset
  // zero, hence, depth = 0.
  let sets = [[]];
  let body = renderDFA(dfa, 0, [], sets, 0);

  // Create resolver function and give it both sets and scopes as parameters
  // then bind sets so that'll always return an entry from sets.
  let resolver = new Function('sets', 'scope', body);
  resolver = resolver.bind(null, sets);
  return {sets, resolver: (scope) => {
      // Optimization so our DFA only has to operate on roleId
      if (scope.startsWith('assume:')) {
        // TODO: note that this might be slightly improved by not taking a slice
        // here but instead modifying the offset at which the current character
        // is read from in renderDFA
        return resolver(scope.slice(7));
      }
      if (scope.endsWith('*') && 'assume'.startsWith(scope.slice(0, -1))) {
        return resolver('*');
      }
      // If it doesn't start with assume:... or a..* then we just return sets[0]
      // which is always the empty set.
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
      // We traverse all implied roles as long as we haven't already seen them
      // in this iteration. But just incrementing the `iteration` variable for
      // each iteration, we don't have to track a list of roles we've seen,
      // which can be a little expensive as we allocate new memory.
      if (r.seen < iteration) {
        r.seen = iteration;
        if (r.expandedScopes) {
          // Note that if we've expanded the scopes for a role already, then
          // there is no reason to traverse this role for scopes as we clearly
          // have the fixed-point for this role.
          scopes = mergeScopeSets(scopes, r.expandedScopes);
        } else {
          scopes = mergeScopeSets(scopes, traveseImpliedRoles(r));
        }
      }
    }
    return scopes;
  };
  //console.time("traveseImpliedRoles");
  // For each role we compute the fixed-point the set of scopes the role expands
  // to when all implied roles are considered. If roles are ordered
  // unfortunately, ie. 1 -> 2 -> 3 -> 4, we can end up traversing the entire
  // tree N times. Our unit tests is good example of this. To avoid these
  // degenerate cases we'll quickly shuffle the roles around. In practice such
  // degenerate cases probably don't exist, but processing order does affect
  // performance, so we shuffle just for good measure.
  for (let R of _.shuffle(roles)) {
    iteration += 1;
    R.seen = iteration;
    // Compute the fixed-point by traversing all implied roles and collecting
    // the scopes they grant us.
    R.expandedScopes = traveseImpliedRoles(R);
    R.impliedRoles = null;
  }
  //console.timeEnd("traveseImpliedRoles");

  // Update results sets of resolver to be scopes
  //console.time("Compute scopes for sets[i]");
  // TODO: This could greatly optimized by allowed nested arrays in
  // buildResolver(), for details see the comment in buildResolver().
  let n = sets.length;
  for (let i = 0; i < n; i++) {
    // At this state sets[i] is a list of roles, we now change that such that
    // sets[i] is a list of scopes that those roles would grant.
    let scopes = [];
    for(let r of sets[i]) {
      scopes = mergeScopeSets(scopes, r.expandedScopes);
    }
    sets[i] = scopes;
  }
  //console.timeEnd("Compute scopes for sets[i]");

  // As we've modified sets[i] for each i, we now have that resolver(scope)
  // returns a list of scopes granted by scope.
  return resolver;
};

// Export computeFixedPoint
exports.computeFixedPoint = computeFixedPoint;
