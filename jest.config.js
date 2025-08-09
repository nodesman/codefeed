/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  cacheDirectory: '<rootDir>/.jest-cache',
  watchman: false,
  maxWorkers: 2,
};
