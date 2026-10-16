const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseSpatialTarget } = require('../extension/spatial-navigation.js');

test('方向优先选择同一行或列的邻近标签；边界停住', () => {
  const targets = [
    { id: 1, left: 0, top: 0, width: 200, height: 40 },
    { id: 2, left: 0, top: 50, width: 200, height: 40 },
    { id: 3, left: 240, top: 0, width: 200, height: 40 },
    { id: 4, left: 240, top: 50, width: 200, height: 40 },
  ];
  assert.equal(chooseSpatialTarget(targets, 1, 'down'), 2);
  assert.equal(chooseSpatialTarget(targets, 1, 'right'), 3);
  assert.equal(chooseSpatialTarget(targets, 4, 'up'), 3);
  assert.equal(chooseSpatialTarget(targets, 1, 'left'), 1);
});
