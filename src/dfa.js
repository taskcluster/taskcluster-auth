const _ = require('lodash');
const {scopeCompare, mergeScopeSets} = require('taskcluster-lib-scopes');

/**
 * Build a DFA of states of the form:
 * ```js
 * {
 *   'a': { ... },  // next state if the current character is 'a'
 *   'end': x,      // index s.t. sets[x] is the roles granted if the scope
 *                  // ends here (end of scope string).
 *   'default': y   // index s.t. sets[y] is the roles granted if the scope
 *                  // doesn't match a next state.
 * }
 * ```
 * The `sets` object is an array given as parameter that new sets of roles will
 * be added to. This ensures that we don't create two array objects to represent
 * the same set of roles. For efficiency, sets[i] for some i, may be an array
 * of indexes s.t. that sets[i] = [..., j] for some j < i. The set is to be
 * interpreted as [...].concat(sets[j]), we allow this for efficiency.
 *
 * Given a set of roles, we want to build a recognizer that will match a given
 * scope against those roles, including support for the kleene star (`*`) in the
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
 *  2. b*
 *  3. b
 *  4. bc
 *  5. c
 *
 * The quick reader may observe that when represented like this we may
 * represent each state of a DFA as character index k, start i and end n offset
 * in the list of possible roleIds matched.  Indeed the generateDFA(roles, i,
 * n, k, sets, implied) function generates a DFA state for roles[i:n]
 * matching character at index k where sets[implied] are previously matched.
 *
 * If we take the roleIds above and generate the DFA state using the generateDFA
 * function below we will get a structure as follows:
 * ```js
 * {
 *   default: 0,                // sets[0] = []
 *   'a': {
 *          end: 1              // sets[1] = ['a']
 *          default: 0,         // sets[0] = []
 *          '*': {
 *                  end: 1,     // sets[1] = ['a']
 *                  default: 1  // sets[1] = ['a']
 *               }
 *        },
 *   'b': {
 *          end: 2,             // sets[2] = ['b', 3] -> ['b', 'b*']
 *          default: 3,         // sets[3] = ['b*']
 *          'c': {
 *                  end: 4,     // sets[4] = ['bc', 3] -> ['bc', 'b*']
 *                  default: 3  // sets[3] = ['b*']
 *                  '*': {
 *                      end: 1,     // sets[4] = ['bc', 3] -> ['bc', 'b*']
 *                      default: 1  // sets[3] = ['b*']
 *                  }
 *               },
 *          '*': {
 *                  end: 5,     // sets[5] = ['b', 'bc', 3] -> ['b', 'bc', 'b*']
 *                  default: 3  // sets[3] = ['b*']
 *               }
 *        },
 *   'c': {
 *          end: 6              // sets[6] = ['c']
 *          '*': {
 *                  end: 6,     // sets[6] = ['C']
 *                  default: 0  // sets[0] = []
 *               }
 *        },
 *   '*': {
 *          end: 7              // sets[7] = [ 'a', 'b', 'b*', 'bc', 'c' ]
 *        }
 * }
 * ```
 *
 * If we we don't have an explicit transition we go to default, hence, if the
 * first character is 'd', the DFA would terminate with 0 as the result, and the
 * set of roles matched would be sets[0] = []. If the first character is 'b', we
 * have already matched the role 'b*', and indeed we see that all the "default"
 * transitions under the 'b' transition would return a set that contains 'b*'.
 *
 * Must be started with:
 *   i = 0, n = roles.length, k = 0, sets = [[]], implied = 0
 *
 * The `implied` is the index of entry in sets that is implied. In the sub-tree
 * under 'b' transition (example above), implied will be 3 (sets[3] = 'b*'). We
 * use to avoid duplicating sets of roles, and for efficiency as we can
 * construct entries in sets as [role, implied].
 */
let generateDFA = (roles, i, n, k, sets, implied) => {
  var state = {default: implied, end: implied};
  // We have to empty array of roles then we're done, we just have the default
  // roles that was already implied and we can't possibly have anything else.
  if (i >= n) {
    return state;
  }
  // We now get a reference to the first role from this subset: j = i
  var j = i;
  var role = roles[j];
  var current = role.roleId[k]; // current character
  // Recall that '*' and '' are sorted to top
  if (current === '*' && role.roleId.length === k + 1) {
    // If current character is a kleene star and the roleId ends after it, then
    // we have already matched a prefix role, so we extend the implied set to
    // include the current role.
    implied = sets.push([role, implied]) - 1;
    // And change the default transition for the current state to implied
    state.default = implied;
    state.end = implied;
    // Now we move to the next role, if there is one
    j += 1;
    if (j >= n) {
      // If there is no next role, we add a '*' transition as we always want to
      // have such a transition. Technically, we don't need it at this level,
      // but to avoid duplicates in sets, we may lookup state['*'].end on for
      // any state returned. So we require the '*' -> {end: ..., default: ...},
      // transition.
      state['*'] = {end: implied, default: implied};
      return state;
    }
    // Find next role and current character
    role = roles[j];
    current = role.roleId[k];
  }
  var afterImplied = j;
  var splitCount = 0;
  if (role.roleId.length === k) {
    // If current roleId ends here then this is an accepting state for the
    // terminal roleId assigned to role. We add the current role to the implied
    // set and sets it's index as state.end.
    state.end = sets.push([role, implied]) - 1;
    // Now we move to the next role, if there is one
    j += 1;
    splitCount += 1;
    if (j >= n) {
      // Again we add a transition for '*', this time we actually need it, as
      // the current role is given for after '*' -> end transition.
      state['*'] = {end: state.end, default: implied};
      return state;
    }
    // Find next role and current character
    role = roles[j];
    current = role.roleId[k];
  }
  var start = j;
  while (j < n) {
    role = roles[j];
    var c = role.roleId[k];
    // Here we go through the roles in the sorted order given, and whenever we
    // encounter a new character we generate a DFA state for it, giving it the
    // start and end-offset in the roles list of when we first saw the character
    // and when it ended.
    if (c !== current) {
      state[current] = generateDFA(roles, start, j, k + 1, sets, implied);
      current = c;
      start = j;
      splitCount += 1;
    }
    j += 1;
  }
  // Same as inside the loop, just for the last character
  state[current] = generateDFA(roles, start, j, k + 1, sets, implied);

  // There must always be a transition for the '*', if it is matched in the
  // scope we're scanning then we must go to a state where if the scope ends
  // you get all the roles is the current sub-tree. This is because '*' at the
  // very end of a scope grants all the scopes matching it up to that '*'.
  var star = state['*'] = state['*'] || {default: implied};

  // if there is only one transition from this state then the current state has
  // the same sub-tree as the state of that transition. Hence, we can just take
  // sets index from the '*' -> end of that transition. Note, this is the place
  // where we require that all states returned contains a '*' -> end transition.
  if (splitCount === 0) {
    star.end = state[current]['*'].end;
  } else {
    let set = roles.slice(afterImplied, n);
    set.push(implied);
    star.end = sets.push(set) - 1;
  }

  return state;
};

// Export generateDFA
exports.generateDFA = generateDFA;

/**
 * Finds the set identifier given a scope and initial state.
 */
let executeDFA = (state, scope, depth = 0) => {
  // If scope ends here and this is a terminal state, return the terminal
  if (state.end !== undefined && scope.length === depth) {
    return state.end;
  }
  // Find next state given current character, and traverse next state
  let next = state[scope[depth]];
  if (next !== undefined) {
    return executeDFA(next, scope, depth+1);
  }
  // If no next state, return the default result or zero if no-default result.
  return state.default || 0;
};

/**
 * Builds a pair {resolver, sets} where sets is a list of lists of roles,
 * and given a scope `resolver(scope)`` returns an index from sets.
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
 * For efficiency we allow sets[i] = [{role}, ..., j] where j < i to be
 * interpreted as sets[i].concat(sets[j]). By not duplicating we don't have to
 * resolve `sets[j]` multiple times, even though the set appears in multiple
 * other sets.
 *
 * The `resolver` function returns an index in the sets array, as this allows
 * us to later create a new sets variable where roles have been expanded to
 * the scopes they imply, and just like that we can use the `resolver` to go
 * from scope to expanded scopes.
 */
let buildResolver = (roles) => {
  // Generate DFA
  roles.sort((a, b) => scopeCompare(a.roleId, b.roleId));
  let sets = [[]];
  let dfa = generateDFA(roles, 0, roles.length, 0, sets, 0);

  // compileDFA is very slow, and doesn't play nice with the GC pushing RSS
  // to several GBs. See compile-dfa.js for the code.
  // let resolver = compileDFA(dfa);

  let resolver = (scope) => executeDFA(dfa, scope);

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
    return 0;
  },
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
    R.scopes.sort(scopeCompare);
    R.impliedRoles = []; // roles that R can directly assume
    R.seen = 0; // later iteration this role was seen (used later)
  }

  let {resolver, sets} = buildResolver(roles);

  // Construct impliedRoles
  for (let R of roles) {
    let expandImpliedRoles = (index) => {
      sets[index].forEach(r => {
        if (typeof r === 'number') {
          expandImpliedRoles(r);
        } else if (!_.includes(R.impliedRoles, r) && r !== R) {
          R.impliedRoles.push(r);
        }
      });
    };
    R.scopes.forEach(scope => expandImpliedRoles(resolver(scope)));
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
  // TODO: make this faster with a simple DFS search and a past-waiting list
  //       this could probably be significantly faster. Might require some smart
  //       cycle handling logic, but it seems fairly feasible.
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

  // Compute scopeSets[i] set of scopes implied by role in sets[i], so that
  // the resolver can be used to resolve scopes
  //console.time("Compute scopeSets");
  let n = sets.length;
  let scopeSets = new Array(n);
  for (let i = 0; i < n; i++) {
    let scopes = [];
    //TODO: make this faster using a min-heap in mergeScopeSets so that can
    //      merge multiple sets at the same time.
    sets[i].map(r => {
      if (typeof r === 'number') {
        return scopeSets[r]; // we know that r < i, hence, this works
      }
      return r.expandedScopes;
    }).forEach(s => {
      scopes = mergeScopeSets(scopes, s);
    });
    scopeSets[i] = scopes;
  }
  //console.timeEnd("Compute scopeSets");

  // As we've scopeSets[i] to be expanded scopes from roles in sets[i], we now
  // have that scopeSets[resolver(scope)] a list of scopes granted by scope.
  return (scope) => scopeSets[resolver(scope)];
};

// Export computeFixedPoint
exports.computeFixedPoint = computeFixedPoint;
