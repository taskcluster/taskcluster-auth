suite("DFA", () => {
  let ScopeResolver = require('../auth/scoperesolver');
  let dfa = require('../auth/dfa');
  let assert = require('assert');
  let _ = require('lodash');

  let testSortRoles = (({roleIds, sorted}) => {
    test('sortRolesForDFAGeneration(' + roleIds.join(',') + ')', () => {
      let roles = roleIds.map(i => {return {roleId: i}});
      roles = dfa.sortRolesForDFAGeneration(roles).map(r => r.roleId);
      if (!_.isEqual(roles, sorted)) {
        console.log("Got: ")
        console.log(roles);
        console.log("Expected: ")
        console.log(sorted);
        assert(false, "Not sorted correctly");
      }
    });
  });

  testSortRoles({
    roleIds: [
      'test-12',
      'test-2',
      'test-11',
      'test-1',
      'test-1*',
      'test-13',
      'test-3',
      'test-10',
      'test-*',
    ],
    sorted: [
      'test-*',
      'test-1',
      'test-1*',
      'test-10',
      'test-11',
      'test-12',
      'test-13',
      'test-2',
      'test-3',
    ],
  });

  testSortRoles({
    roleIds: ['(', '*', ''],
    sorted: ['', '*', '('],
  });

  testSortRoles({
    roleIds: ['ab(', 'ab*', 'aa'],
    sorted: ['aa', 'ab*', 'ab('],
  });


  let testMergeScopeSets = (title, {scopesA, scopesB, expected}) => {
    test("mergeScopeSets (" + title + ")", () => {
      let results = dfa.mergeScopeSets(
        dfa.sortScopesForMerge(scopesA),
        dfa.sortScopesForMerge(scopesB)
      );
      if (!_.isEqual(results, expected)) {
        console.log('expected:');
        console.log(expected);
        console.log('got:');
        console.log(results);
        assert(false, "Expected different result!");
      }
    });
  };

  testMergeScopeSets('simple sort', {
    scopesA: _.shuffle(['a', 'b', 'c']),
    scopesB: [],
    expected: ['a', 'b', 'c'],
  });

  testMergeScopeSets('simple sort w. star', {
    scopesA: _.shuffle(['a*', 'b', 'c']),
    scopesB: [],
    expected: ['a*', 'b', 'c'],
  });

  testMergeScopeSets('complex sort', {
    scopesA: _.shuffle([
      'assume:tr-0',
      'assume:tr-1',
      'assume:tr-10',
      'assume:tr-2',
      'assume:tr-3',
      'assume:tr-4',
      'assume:tr-5',
      'assume:tr-6',
      'assume:tr-7',
      'assume:tr-8',
      'assume:tr-9',
      'special-scope',
    ]),
    scopesB: [],
    expected: [
      'assume:tr-0',
      'assume:tr-1',
      'assume:tr-10',
      'assume:tr-2',
      'assume:tr-3',
      'assume:tr-4',
      'assume:tr-5',
      'assume:tr-6',
      'assume:tr-7',
      'assume:tr-8',
      'assume:tr-9',
      'special-scope',
    ],
  });

  testMergeScopeSets('can normalize', {
    scopesA: ['b*', 'ab', 'aa', 'a*'],
    scopesB: [],
    expected: ['a*', 'b*'],
  });

  testMergeScopeSets('sanity check (1)', {
    scopesA: ['assume:tr-10','assume:tr-9','special-scope'],
    scopesB: [],
    expected: ['assume:tr-10','assume:tr-9','special-scope'],
  });

  testMergeScopeSets('sanity check (2)', {
    scopesA: [],
    scopesB: ['assume:tr-10','assume:tr-9','special-scope'],
    expected: ['assume:tr-10','assume:tr-9','special-scope'],
  });


  testMergeScopeSets('can normalize two', {
    scopesA: _.shuffle(['b*', 'ab', 'aa', 'a*', 'c', 'ca', 'da*']),
    scopesB: _.shuffle(['b*', 'ab', 'aa', 'a*', 'abc', 'ab*', 'ca', 'daa']),
    expected: ['a*', 'b*', 'c', 'ca', 'da*'],
  });

  let testBuildResolver = (title, {roleIds, scope, expected}) => {
    test("buildResolver (" + title + ")", () => {
      let roles = roleIds.map(i => {return {roleId: i}});
      console.time("buildResolver");
      let {resolver, sets} = dfa.buildResolver(roles);
      console.timeEnd("buildResolver");

      let results = resolver(scope).map(r => r.roleId);
      if (_.xor(results, expected).length !== 0) {
        console.log('expected:');
        console.log(expected);
        console.log('got:');
        console.log(results);
        assert(false, "Expected different result!");
      }
    });
  };

  testBuildResolver('* get all', {
    roleIds: ['a', 'b', 'c'],
    scope: '*',
    expected: ['a', 'b', 'c'],
  });

  testBuildResolver('a* get all', {
    roleIds: ['a', 'b', 'c'],
    scope: 'a*',
    expected: ['a', 'b', 'c'],
  });

  testBuildResolver('assume* get all', {
    roleIds: ['a', 'b', 'c'],
    scope: 'assume*',
    expected: ['a', 'b', 'c'],
  });

  testBuildResolver('assume:* get all', {
    roleIds: ['a', 'b', 'c'],
    scope: 'assume:*',
    expected: ['a', 'b', 'c'],
  });

  testBuildResolver('assum* get all', {
    roleIds: ['a', 'b', 'c'],
    scope: 'assum*',
    expected: ['a', 'b', 'c'],
  });

  testBuildResolver('assume:a works', {
    roleIds: ['a', 'b', 'c'],
    scope: 'assume:a',
    expected: ['a'],
  });

  testBuildResolver('exact match ab', {
    roleIds: ['a', 'ab', 'abc'],
    scope: 'assume:ab',
    expected: ['ab'],
  });

  testBuildResolver('ab* matches ab, abc', {
    roleIds: ['a', 'ab', 'abc'],
    scope: 'assume:ab*',
    expected: ['ab','abc'],
  });

  testBuildResolver('ab* matches a*', {
    roleIds: ['a*', 'ab', 'abc'],
    scope: 'assume:ab*',
    expected: ['a*', 'ab','abc'],
  });

  testBuildResolver('ab match ab,a*', {
    roleIds: ['a*', 'ab', 'abc'],
    scope: 'assume:ab',
    expected: ['a*', 'ab'],
  });

  testBuildResolver('try with 50', {
    roleIds: _.range(50).map(i => 't-' + i),
    scope: 'assume:t-1',
    expected: ['t-1'],
  });

  testBuildResolver('try with 500', {
    roleIds: _.range(500).map(i => 't-' + i),
    scope: 'assume:t-12*',
    expected: _.range(10).map(i => 't-12' + i).concat('t-12')
  });

  testBuildResolver('try with 5000', {
    roleIds: _.range(5000).map(i => 't-' + i),
    scope: 'assume:t-122*',
    expected: _.range(10).map(i => 't-122' + i).concat('t-122')
  });

  testBuildResolver('try with 5000 - exact match', {
    roleIds: _.range(5000).map(i => 't-' + i),
    scope: 'assume:t-1234',
    expected: ['t-1234']
  });


  let testFixedPointComputation = (title, {roles, scope, expected}) => {
    test(title, () => {
      let resolver = dfa.computeFixedPoint(roles);

      let results = resolver(scope);
      if (_.xor(results, expected).length !== 0) {
        console.log('expected:');
        console.log(expected);
        console.log('got:');
        console.log(results);
        assert(false, "Expected different result!");
      }
    });
  };

  testFixedPointComputation('* get all', {
    roles: [
      {
        roleId: 'client-id:root',
        scopes: ['*']
      }
    ],
    scope: '*',
    expected: ['*']
  });

  testFixedPointComputation('client-id:* get all', {
    roles: [
      {
        roleId: 'client-id:root',
        scopes: ['*']
      }
    ],
    scope: 'assume:client-id:*',
    expected: ['*']
  });

  testFixedPointComputation('client-id:root get all', {
    roles: [
      {
        roleId: 'client-id:root',
        scopes: ['*']
      }
    ],
    scope: 'assume:client-id:root',
    expected: ['*']
  });


  testFixedPointComputation('test with stupid', {
    roles: [
      {
        roleId: 'client-id:big-test-client',
        scopes: ['assume:test-role-0']
      }, {
        roleId: 'test-role-10',
        scopes: ['special-scope']
      }, {
        roleId: 'test-role-0',
        scopes: ['assume:test-role-2']
      }, {
        roleId: 'test-role-2',
        scopes: ['assume:test-role-10']
      },
    ],
    scope: 'assume:client-id:big-test-client',
    expected: [
      'special-scope',
      'assume:test-role-0',
      'assume:test-role-2',
      'assume:test-role-10'
    ]
  });

  const N = 500;
  testFixedPointComputation('test with N = ' + N, {
    roles: [
      {
        roleId: 'client-id:c',
        scopes: ['assume:tr-0']
      }, {
        roleId: 'tr-' + N,
        scopes: ['special-scope']
      }
    ].concat(_.range(N).map(i => {
      return {
        roleId: 'tr-' + i,
        scopes: ['assume:tr-' + (i + 1)]
      };
    })),
    scope: 'assume:client-id:c',
    expected: [
      'special-scope'
    ].concat(_.range(N + 1).map(i => 'assume:tr-' + i))
  });


  const M = 5;  // depth
  const K = 500; // multiplier
  testFixedPointComputation('test with depth = ' + M + " x " + K, {
    roles: _.flatten([
      _.flatten(_.range(K).map(k => {
        return _.flatten(_.range(M).map(m => {
          return {
            roleId: 'k-' + k + '-' + m,
            scopes: ['assume:k-' + k + '-' + (m + 1)]
          };
        }));
      })),
      _.range(K).map(k => {
        return {
          roleId: 'k-' + k + '-' + M,
          scopes: ['special-scope']
        };
      }),
      [{
        roleId: 'client-id:c',
        scopes: ['assume:k-2-0']
      }]
    ]),
    scope: 'assume:client-id:c',
    expected: [
      'special-scope'
    ].concat(_.range(M + 1).map(i => 'assume:k-2-' + i))
  });

});